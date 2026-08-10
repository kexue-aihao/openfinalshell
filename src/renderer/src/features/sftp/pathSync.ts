/**
 * 终端 `cd` → SFTP 面板跟随的纯逻辑。解析（parseCdTarget）与应用（applyCd）分开，
 * 不 import 任何东西 —— 单测零 mock 就能把全部分支跑真。
 *
 * 设计取向是**宁可不跳，不要跳错**：所有静态推导不出来的形态（`cd -` 的 OLDPWD、
 * `cd ~otheruser`、`cd $VAR`）一律返回 null 原地不动。跳错一次给用户的信息是
 * "这个功能不可信"，比十次没跳伤得重。
 */

/** 无引号包裹时终止一条命令的分隔符（`cd /tmp && ls` 只看第一段） */
const SEPARATOR = /^(?:&&|\|\||[;|&])/

/**
 * 从一条即将执行的命令里解析 cd 的目标。
 * 不是 cd、或目标无法静态推导 → null。`cd`（无参）→ '~'（交给 applyCd 用 home 解析）。
 */
export function parseCdTarget(command: string): string | null {
  const first = firstSegment(command).trim()
  if (first !== 'cd' && !/^cd\s/.test(first)) return null

  const tokens = splitTokens(first.slice(2))
  // 跳过 cd 的选项：-P/-L（bash/zsh 都有）；`--` 是"选项到此为止"
  let i = 0
  while (i < tokens.length && (tokens[i] === '-P' || tokens[i] === '-L' || tokens[i] === '--')) i++
  const rest = tokens.slice(i)

  if (rest.length === 0) return '~'
  // `cd -` 去 OLDPWD、`$VAR`/反引号/`$(...)` 要 shell 展开 —— 都推导不了
  const target = rest[0]
  if (target === '-') return null
  if (/[$`]/.test(target)) return null
  return target
}

/**
 * 把 cd 目标应用到当前目录，返回规范化的绝对 POSIX 路径；解析不动 → null。
 * `home` 是会话初始化时 realpath('.') 的结果，拿不到时 `~` 类目标放弃。
 */
export function applyCd(cwd: string, target: string, home: string | null): string | null {
  if (!target) return null
  if (target === '~') return home ? normalizePosix(home) : null
  if (target.startsWith('~/')) return home ? normalizePosix(`${home}/${target.slice(2)}`) : null
  if (target.startsWith('~')) return null // ~user：别人的 home 无法解析
  if (target.startsWith('/')) return normalizePosix(target)
  if (!cwd.startsWith('/')) return null // cwd 还没初始化好，相对路径没有基准
  return normalizePosix(`${cwd}/${target}`)
}

/**
 * 导航中的显示派生：已确认目录 + 正在去的目录 → 面板该显示什么。
 *
 * 提成纯函数是因为其中一条规则特别容易被"顺手简化"掉：`navPending` **必须**排除
 * 同目录刷新。写成 `pendingDir !== null` 的话，每次刷新（以及传输完成后的自动刷新、
 * 重连后的补拉）都会把表格换成骨架闪一下 —— 用户手里的滚动位置和选中项跟着丢。
 *
 * - `displayDir`：面包屑与路径框读它（一发起导航就翻页，不等网络往返）。
 * - `navPending`：真在换目录。只有它为真时列表位置放骨架，并且禁掉往目录里写的入口。
 *
 * 注意**写操作一律不读这里**：它们读已确认的 cwd，否则导航失败（cd 打错）时
 * 会把文件写进一个根本没去成的目录。
 */
export function navView(
  cwd: string,
  pendingDir: string | null
): { displayDir: string; navPending: boolean } {
  return {
    displayDir: pendingDir ?? cwd,
    navPending: pendingDir !== null && pendingDir !== cwd
  }
}

/** POSIX 规范化：消 `.`/`..`（越过根停在根）、并去重斜杠与尾斜杠 */
export function normalizePosix(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return `/${out.join('/')}`
}

/** 取引号感知的第一段：未被引号包裹的 && / || / ; / | / & 处截断 */
function firstSegment(command: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      // 单引号里无转义；双引号里 \" 不关引号
      if (ch === quote && !(quote === '"' && command[i - 1] === '\\')) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '\\') {
      i++ // 跳过被转义的下一个字符
      continue
    }
    if (SEPARATOR.test(command.slice(i))) return command.slice(0, i)
  }
  return command
}

/** 按 shell 规则切词：支持 "a b"、'a b'、a\ b 三种带空格形态（不做变量展开） */
function splitTokens(s: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  const push = (): void => {
    if (inToken) tokens.push(cur)
    cur = ''
    inToken = false
  }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
      continue
    }
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i]
      inToken = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      push()
      continue
    }
    cur += ch
    inToken = true
  }
  push()
  return tokens
}
