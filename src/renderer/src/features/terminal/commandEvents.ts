/**
 * "这个 tab 的终端里刚执行了一条命令"的模块级登记簿（形态照 termRegistry）。
 *
 * 生产方是 TerminalPane 的 Enter 采集（命令文本来自 commandCapture —— 屏幕上回显的
 * 那一行，不是按键流）；消费方目前只有 SftpPane 的 cd 跟随。刻意发**整条命令**而不是
 * 只发 cd：解析归消费方，这里只负责送达。
 *
 * 每个 tab 至多一个订阅者就够了（SftpPane 一个 tab 只挂一份）；真出现第二个消费方时
 * 再改成数组，现在不为想象中的需求付复杂度。
 */

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
