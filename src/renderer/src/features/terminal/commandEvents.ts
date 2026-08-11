/**
 * "这个 tab 的终端里刚执行了一条命令"的模块级登记簿（形态照 termRegistry）。
 *
 * 生产方有两个：TerminalPane 的 Enter 采集（命令文本来自 commandCapture —— 屏幕上
 * 回显的那一行，不是按键流），和程序化执行的宣告（emitExecutedCommands，见下）。
 * 消费方目前只有 SftpPane 的 cd 跟随。刻意发**整条命令**而不是只发 cd：
 * 解析归消费方，这里只负责送达。
 *
 * 每个 tab 至多一个订阅者就够了（SftpPane 一个 tab 只挂一份）；真出现第二个消费方时
 * 再改成数组，现在不为想象中的需求付复杂度。
 */
import type { TermId } from '@shared/types'
import { getTerm } from './termRegistry'

type CommandHandler = (command: string) => void

const handlers = new Map<string, CommandHandler>()

/** 订阅某个 tab 的已执行命令；返回退订函数。同 tab 重复订阅按后到覆盖。 */
export function onShellCommand(tabId: string, handler: CommandHandler): () => void {
  handlers.set(tabId, handler)
  return () => {
    if (handlers.get(tabId) === handler) handlers.delete(tabId)
  }
}

/** TerminalPane 在 Enter 采集成功后调用。无订阅者时是 no-op。 */
export function emitShellCommand(tabId: string, command: string): void {
  try {
    handlers.get(tabId)?.(command)
  } catch {
    /* 消费方的异常不许影响回车（与命令历史采集同一条纪律） */
  }
}

/**
 * 程序化执行（快捷命令 / 命令编辑器带回车走 term:exec）的命令宣告。
 *
 * Enter 采集那条路靠"keydown 快照 → 回显换行读屏"，而程序化执行**没有 keydown**，
 * 整条采集链路不启动 —— 命令照常执行、历史照常记（发送侧自己 push），
 * 唯独这里的事件一条不发，SFTP 的 cd 跟随就静默断掉。所以发送方在发出 term:exec
 * 的同时自己宣告。文本是发送方手里现成的，不需要等回显读屏；按行拆开逐条发 ——
 * 多行体的每一行都是一条独立命令（heredoc 里的"行"分不出来，认了：与读屏采集
 * 把 PS2 续行也只认第一行是同一档取舍）。
 *
 * 与读屏采集对齐的一条守卫：终端正被全屏程序占着（vim/less，alternate buffer）时
 * 一条都不发 —— 写进去的字节喂给了 vim，不是 shell 命令（captureSubmitted 同一条纪律）。
 * 实例还没注册时视同 normal：termId 在而实例不在只发生在拆卸竞态里，多发一条
 * 无人消费的事件无害，少发一条该跟随的 cd 才是这次要修的事故。
 *
 * **只在真的执行了（带回车）时调用**。文本躺在命令行上等用户按 Enter 的那种，
 * 归 Enter 采集管 —— 在这里发等于"没执行也宣告"。
 */
export function emitExecutedCommands(tabId: string, termId: TermId, text: string): void {
  if (getTerm(termId)?.buffer.active.type === 'alternate') return
  for (const line of text.split('\n')) {
    const command = line.trim()
    if (command) emitShellCommand(tabId, command)
  }
}
