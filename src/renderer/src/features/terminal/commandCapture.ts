import { COMMAND_HISTORY_MAX_CHARS } from '@shared/constants'

/**
 * 从终端缓冲里取出"用户刚敲下回车的那条命令"。
 *
 * ---
 *
 * **为什么不从 `term:input` 的按键流里拼？** 因为按键流不等于命令。用户按退格、按 ↑
 * 从 shell 自己的历史里翻出一条、按 Tab 让 shell 补全、粘贴一段（bracketed paste）——
 * 这几种里没有一种能靠累加按键还原出最终那一行。而**屏幕上的那一行**是 shell 自己回显的，
 * 它就是真相。所以采集的输入是 xterm 的缓冲，时机是 Enter 的 keydown（此刻 shell
 * 还没处理回车，那一行还在）。
 *
 * **怎么把提示符从命令里切开** —— 两条路，按可靠性排序：
 *
 * 1. **提示符末尾列（promptCol）**。用户在某一行敲下**第一个键**时，光标必然正停在
 *    提示符末尾（PromptTracker 就记这一件事）。这条不需要认识任何提示符长什么样，
 *    emoji 提示符、powerline、多级 git 状态一律照办。
 * 2. **提示符启发式**：找第一个 `$ ` / `# ` / `% `，取它后面的部分。用在第 1 条量不到的
 *    场合（这一行第一个键就是 Enter、程序往里写过字、缓冲滚动过头）。
 *    刻意**不认 `> `**：那会把 `echo a > b.txt` 切成 `b.txt`，而它换来的只是 PS2
 *    续行的碎片 —— 拿一条真命令被记错去换一条碎片被记下，不划算。
 *
 * 两条都失败就**不记**。宁可少一条，也不要把提示符（里面有主机名、路径，某些 PS1
 * 里还有 git 分支）当成命令存进一张会持久化的表。
 */

// ---------------------------------------------------------------------------
// 只用到 xterm 缓冲的这几样 —— 声明成结构类型，于是 node 里能用一个假缓冲把逻辑跑真
// （测试环境没有 DOM，真 Terminal 起不来；而这几行判断正是最该被测的部分）
// ---------------------------------------------------------------------------

export interface BufferLineLike {
  isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

export interface BufferLike {
  /** 'alternate' = vim/less/htop 之类占了整屏，那里的回车不是 shell 命令 */
  type: 'normal' | 'alternate'
  baseY: number
  cursorX: number
  cursorY: number
  getLine(y: number): BufferLineLike | undefined
}

/** 一条命令最多跨多少屏行去拼。够 80 列 × 64 行 = 5120 字符，远超命令长度上限 */
const MAX_WRAP_ROWS = 64

/** 提示符启发式认的三个结尾。`>` 不在其中，理由见文件头 */
const PROMPT_END = /[$#%] /

/**
 * 提示符那一段里出现这些词就整条不记。
 *
 * 覆盖的是 `sudo` / `ssh` / `git` 这类**会回显**用户输入的口令类提问
 * （不回显的那些天然记不到：屏幕上没有字，切出来是空的）。
 * 这不是万无一失的（一个叫 "输入你的 API key:" 的提问就漏了）——
 * 所以另有设置开关与「清空列表」，README 里也写明了。
 */
const SECRET_PROMPT = /pass(word|phrase)|密码|口令|secret|token/i

/** 逻辑行的起始屏行：从光标所在行往上走，直到不再是"上一行换行溢出来的" */
function logicalStartRow(buf: BufferLike): number {
  let row = buf.baseY + buf.cursorY
  let guard = MAX_WRAP_ROWS
  while (row > 0 && guard-- > 0 && buf.getLine(row)?.isWrapped) row--
  return row
}

/**
 * 把（可能因为超过列宽而折行的）逻辑行拼成一个字符串。
 *
 * 每一屏行都用 `translateToString(false)` 取**不去尾空格**的版本 —— 折行处一去尾就会
 * 少掉那些补满行宽的空格，后面的列号全部错位（promptCol 就是列号）。只在最后统一去尾。
 */
export function readLogicalLine(buf: BufferLike): string {
  const start = logicalStartRow(buf)
  let text = ''
  for (let y = start; y < start + MAX_WRAP_ROWS; y++) {
    const line = buf.getLine(y)
    if (!line) break
    if (y > start && !line.isWrapped) break
    text += line.translateToString(false)
  }
  return text.replace(/\s+$/, '')
}

/**
 * 从一整行（含提示符）里切出命令。切不出来返回 null。
 *
 * `promptCol` 为 null 表示"量不到提示符末尾"，走启发式。
 */
export function extractCommand(line: string, promptCol: number | null): string | null {
  let cut: number
  if (promptCol !== null && promptCol >= 0 && promptCol <= line.length) {
    cut = promptCol
  } else {
    const m = PROMPT_END.exec(line)
    if (!m) return null
    cut = m.index + m[0].length
  }

  const command = line.slice(cut).trim()
  if (command.length === 0) return null
  if (command.length > COMMAND_HISTORY_MAX_CHARS) return null
  // 提示符那一段在问口令 → 后面跟着的很可能就是口令本身
  if (SECRET_PROMPT.test(line.slice(0, cut))) return null
  return command
}

/**
 * 记住"每一行的提示符末尾在第几列"。
 *
 * 一个终端一个实例。三个方法之间的关系就是这个类的全部语义：
 *
 * - `noteKeystroke`：这一行**第一次**见到按键时把 cursorX 记下来。之后同一行的按键
 *   一律不再更新 —— 用户接着打的字会让光标右移，而我们要的是提示符末尾那个位置。
 * - `noteProgrammaticWrite`：程序（快捷命令、历史回填、粘贴）往终端里写过字。
 *   此后这一行的 promptCol **不可信**：写进去的内容不是用户敲的，但光标已经被它推走了，
 *   下一次按键记到的列会把命令头部切掉。所以标成不可信，逼它退回启发式。
 * - `promptColFor`：只有"还在同一逻辑行且可信"时才给出列号。
 *
 * 比较的是**逻辑行**起始行而不是光标所在行 —— 否则一条长命令一折行，
 * 光标行就与记下的行不同了，promptCol 白记。
 */
export class PromptTracker {
  private row: number | null = null
  private col = 0
  private trusted = true

  noteKeystroke(buf: BufferLike): void {
    const row = logicalStartRow(buf)
    if (this.row === row) return
    this.row = row
    this.col = buf.cursorX
    this.trusted = true
  }

  noteProgrammaticWrite(buf: BufferLike): void {
    this.row = logicalStartRow(buf)
    this.col = 0
    this.trusted = false
  }

  promptColFor(buf: BufferLike): number | null {
    if (this.row === null || !this.trusted) return null
    return this.row === logicalStartRow(buf) ? this.col : null
  }
}

/**
 * 一次完整采集：全屏程序里不记，其余按上面两条路切。
 *
 * 全屏程序（alternate buffer）这条守卫是**必须**的，不是保险：vim 里每按一次回车
 * 都会被当成一条命令记下来，历史会被 vim 里的正文塞满 —— 而那些正文恰恰是
 * 用户最不想被存进一张持久化表里的东西（他正在编辑的文件内容）。
 */
export function captureCommand(buf: BufferLike, tracker: PromptTracker): string | null {
  if (buf.type === 'alternate') return null
  return extractCommand(readLogicalLine(buf), tracker.promptColFor(buf))
}
