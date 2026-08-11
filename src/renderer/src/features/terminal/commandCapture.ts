import { COMMAND_HISTORY_MAX_CHARS } from '@shared/constants'

/**
 * 从终端缓冲里取出"用户刚敲下回车的那条命令"。
 *
 * ---
 *
 * **为什么不从 `term:input` 的按键流里拼？** 因为按键流不等于命令。用户按退格、按 ↑
 * 从 shell 自己的历史里翻出一条、按 Tab 让 shell 补全、粘贴一段（bracketed paste）——
 * 这几种里没有一种能靠累加按键还原出最终那一行。而**屏幕上的那一行**是 shell 自己回显的，
 * 它就是真相。所以采集的输入是 xterm 的缓冲。
 *
 * **时机是"换行回来的那一刻"，不是 Enter 的 keydown。** 这一条是踩出来的：
 * 屏幕上的字全靠**服务器回显**，本地不回显。在 keydown 那一刻去读屏，最后几个字符
 * 可能还在路上 —— 尤其是按 Tab 让服务器补全（`cd /etc/v2n` + Tab → `/etc/v2node`），
 * 补全结果更是必然还没回来。于是采到的是被**截断**的命令：真实事故是
 * `cd /etc/v2node` 被采成 `cd /etc/v2n`，SFTP 跟随据此去读一个不存在的目录，
 * 命令历史也一并被截断污染，且两者都不报错（跟随那条路是静默的）。
 *
 * 服务器处理输入是**有序**的：先回显剩下的字符（含补全结果），再回显命令行的换行。
 * 所以"第一个换行到达"时，那一行必然已经完整。于是分两步：Enter 的 keydown 只
 * 快照提示符列（见 PromptTracker.snapshot），换行到达时才真正读那一行（captureSubmitted）。
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
  return readLogicalLineFrom(buf, logicalStartRow(buf))
}

/** 从给定的起始屏行往下拼，直到不再是折行 */
function readLogicalLineFrom(buf: BufferLike, start: number): string {
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
 * 读**结束于 endRow** 的那条逻辑行（先往上找起点，再往下拼）。
 * 提交之后的采集要用它：那时光标已经在下一行，要读的是它上面那一条。
 */
export function readLogicalLineEndingAt(buf: BufferLike, endRow: number): string {
  let start = endRow
  let guard = MAX_WRAP_ROWS
  while (start > 0 && guard-- > 0 && buf.getLine(start)?.isWrapped) start--
  return readLogicalLineFrom(buf, start)
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
  /**
   * 测到 `col` 那一刻、它之前的那段文本（就是提示符本身）。
   *
   * ⚠️ **这一份是必需的，不是冗余**：绝对行号会被 xterm 复用，这段文本不会。
   * 详见 noteKeystroke 里那段注释。
   */
  private prompt = ''

  noteKeystroke(buf: BufferLike): void {
    const row = logicalStartRow(buf)
    const line = readLogicalLine(buf)
    /*
     * 还是那一行 → 不重测（要的是提示符末尾那一列，不是用户打字之后的光标位置）。
     *
     * ⚠️ **"还是那一行"不能只看行号。** 行号是 `baseY + cursorY`，而它并不随时间单调：
     * xterm 的 scrollback 一满，`ybase` 就不再增长、行改为环形复用
     * （`BufferService.scroll`：`if (!willBufferBeTrimmed) buffer.ybase++`），
     * `clear()`（消除按钮 / shell 的 clear）更是直接把 ybase 与 y 归零。
     * 于是**此后每一个新提示符都落在同一个绝对行号上**。
     *
     * 只按行号判断的后果：这道守卫永久早退 → `col` 冻结在第一次测到的那一列。
     * 而 PS1 里通常带 cwd，用户一 `cd` 提示符长度就变，按冻结的列去切，切出来的是
     * `p# cd /var/log` 这种残片 —— 命令历史被污染，SFTP 的 cd 跟随（parseCdTarget
     * 解析残片得 null）**整条链静默失效**。而且它是不对称的：cwd 比冻结时深就坏、
     * 浅则碰巧还对，所以表现为"时好时坏、又出现了"。
     *
     * 所以再比一次那段前缀：行号能被复用，那段文本不能。提示符一变就重测，自愈。
     * 这一条同时管住 noteProgrammaticWrite 的不可信闩：闩只在**那一行**有效，
     * 行被复用出一个新提示符时会重新测量并恢复可信，不会永久卡在启发式上。
     */
    if (this.row === row && line.startsWith(this.prompt)) return
    this.row = row
    this.col = buf.cursorX
    this.prompt = line.slice(0, buf.cursorX)
    this.trusted = true
  }

  noteProgrammaticWrite(buf: BufferLike): void {
    this.row = logicalStartRow(buf)
    this.col = 0
    // 记下写之前这一行的样子（调用约定是"写之前调"，那时它就是提示符本身）：
    // 上面那道守卫靠它判断闩还该不该继续闩着
    this.prompt = readLogicalLine(buf)
    this.trusted = false
  }

  /** 这一行已提交（回车）。下一行必须重新测量，测量结果不许跨行泄漏 */
  noteSubmit(): void {
    this.row = null
    this.col = 0
    this.prompt = ''
    this.trusted = true
  }

  promptColFor(buf: BufferLike): number | null {
    if (this.row === null || !this.trusted) return null
    if (this.row !== logicalStartRow(buf)) return null
    // 行号对得上也可能是复用来的另一行：那段提示符还在原位才认这个列号，
    // 否则宁可返回 null 退回启发式，也不按一个已经不成立的列号硬切
    return readLogicalLine(buf).startsWith(this.prompt) ? this.col : null
  }

  /**
   * 回车那一刻把"提示符在第几列"带走。**刻意不带行号**：
   * 从回车到换行回来这段时间里缓冲可能滚动，而缓冲满了之后行是环形复用的，
   * 绝对行号会漂。列号与提示符文本都不会漂，凭这两样就够认出那一行。
   */
  snapshot(): PromptSnapshot {
    return { col: this.col, trusted: this.trusted && this.row !== null, prompt: this.prompt }
  }
}

/** 回车那一刻的提示符信息，交给换行到达时的采集用 */
export interface PromptSnapshot {
  col: number
  trusted: boolean
  prompt: string
}

/**
 * 一次完整采集：全屏程序里不记，其余按上面两条路切。
 *
 * 全屏程序（alternate buffer）这条守卫是**必须**的，不是保险：vim 里每按一次回车
 * 都会被当成一条命令记下来，历史会被 vim 里的正文塞满 —— 而那些正文恰恰是
 * 用户最不想被存进一张持久化表里的东西（他正在编辑的文件内容）。
 */
export function captureSubmitted(buf: BufferLike, snap: PromptSnapshot): string | null {
  if (buf.type === 'alternate') return null
  // 光标已经在提交后的新行上，要读的是它**上面**那一条逻辑行
  const endRow = buf.baseY + buf.cursorY - 1
  if (endRow < 0) return null
  const line = readLogicalLineEndingAt(buf, endRow)
  /*
   * 认这个列号的条件：快照可信，且那段提示符**还在这一行的开头**。
   * 后一条是必需的 —— 万一第一个到达的换行不是命令行的回显（比如 stty -echo，
   * 或者服务器先吐了别的东西），内容比对会对不上，于是退回启发式而不是按一个
   * 不相干的列号硬切出一段假命令。
   */
  const promptCol =
    snap.trusted && snap.prompt !== '' && line.startsWith(snap.prompt) ? snap.col : null
  return extractCommand(line, promptCol)
}
