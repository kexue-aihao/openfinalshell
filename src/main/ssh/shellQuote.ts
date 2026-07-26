/**
 * POSIX shell 参数转义 —— 纯函数、**零 import**。
 *
 * 本模块不认识路径、也不认识 SSH，它只回答一个问题：怎么把一个任意字符串塞进
 * `sh` 的命令行里、让它被当成**恰好一个字面参数**。反过来，路径的合法性归
 * `sftp/remotePath.ts` 的 assertSafeRemotePath 管，命令的组装归各命令构造器管。
 * 这条分层是刻意的：混在一起的话，"这个字符串到底被谁检查过"就再也说不清。
 *
 * 项目当初把 SFTP 压缩/解压推到 v1.5 就是因为注入风险，这个文件是那笔债的头一块砖，
 * 所以它的测试是**精确字符串比对的用例表**（test/unit/shellQuote.test.ts），不是抽样。
 */

/** 参数里有 shell 层面根本无法表达的字节（目前只有 NUL）时抛出 */
export class UnsafeArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeArgError'
  }
}

/**
 * 用单引号包裹一个参数。
 *
 * 单引号里除了 `'` 自己**没有任何字符**具有特殊含义 —— 没有变量展开、没有命令替换、
 * 没有通配、没有反斜杠转义。所以这个函数只处理 `'`：把它写成 `'\''`
 * （关掉引号 → 反斜杠转义一个裸的 `'` → 重新开引号），别的一个字符都不碰。
 *
 * 三条最容易写错、必须钉住的语义：
 *
 * 1. **反斜杠原样保留**。拿双引号的思维写这个函数（顺手把 `\` 也转义掉）是经典 bug：
 *    单引号里 `\` 就是一个反斜杠，多转一次就把 `C:\x` 变成了 `C:\\x`。
 * 2. **换行不拒**。单引号里的换行是合法字面量、仍然属于同一个参数，在这一层拒掉是错的
 *    （真实的远端文件名可以含换行）。"不许有换行"是**协议**约束 —— 我们按行解析命令输出 ——
 *    归 assertSafeRemotePath 管，不归这里。
 * 3. **转义挡不住选项注入**。`shQuote('-rf')` 得到 `'-rf'`，而 `rm '-rf'` 里它依然是个选项。
 *    所以每个命令构造器都必须另外做到两件事：只接绝对路径、且操作数前放 `--`。
 *
 * NUL 是唯一的例外：execve 的参数以 NUL 结尾，没有任何引法能把它塞进一个参数里，
 * 悄悄截断比报错危险得多（`/data/x\0/../../etc` 截断后就是另一条路径）。
 */
export function shQuote(arg: string): string {
  if (arg.includes('\0')) {
    throw new UnsafeArgError('参数含 NUL 字节，无法作为 shell 参数传递')
  }
  return `'${arg.replace(/'/g, "'\\''")}'`
}

/**
 * 把一整段脚本包成一条可以直接交给 `exec` 的命令行。**所有远端命令都必须走这里。**
 *
 * 两件事各有理由：
 *
 * - `sh -c <整段脚本>`：用户的登录 shell 可能是 csh/fish/zsh，语法与 POSIX sh 并不兼容。
 *   包一层之后它只会看到**一个不透明参数**，脚本里的分号、`$?`、`for` 一律由 sh 解释。
 * - `env LC_ALL=C LANG=C`：强制成可解析的输出（与 monitor/script.ts 同一理由 ——
 *   本地化过的 `rm` 报错和数字格式会让解析出错）。
 *
 * 注意这里发生了**一次嵌套**：脚本内部的 `'` 到外层变成 `'\''`。所以命令构造器的单测
 * 一律用精确字符串比对，且有一条三层嵌套的用例把这条包法钉死 —— 谁"简化"了这层包装，
 * 那条用例就是红的。
 *
 * 刻意**不**提供 `shJoin(argv)`：给 `-rf`、`--` 这种固定选项也套上引号只会掩盖笔误，
 * 而真正需要转义的是变量部分，那由构造器逐个 shQuote。
 */
export function wrapShellScript(script: string): string {
  return `env LC_ALL=C LANG=C sh -c ${shQuote(script)}`
}
