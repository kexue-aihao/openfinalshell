import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { ZodType } from 'zod'
import type { EventMap, InvokeMap, SendMap } from '@shared/ipc'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('ipc')

let mainWindow: BrowserWindow | null = null

export function bindMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

/** 只接受本应用页面发来的 IPC（dev server 或打包后的 file://） */
function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const url = event.senderFrame?.url ?? ''
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const trusted = (devUrl && url.startsWith(devUrl)) || url.startsWith('file://')
  if (!trusted) {
    log.warn(`rejected IPC from untrusted sender: ${url}`)
    throw new Error('IPC sender not trusted')
  }
}

/** 注册 invoke 处理器；schema 传入时对 args 数组做 zod 校验 */
export function handle<K extends keyof InvokeMap>(
  channel: K,
  fn: (...args: InvokeMap[K]['args']) => Promise<InvokeMap[K]['result']> | InvokeMap[K]['result'],
  schema?: ZodType
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event)
    if (schema) {
      const parsed = schema.safeParse(args)
      if (!parsed.success) {
        // 带上出错字段的路径与规则名，只说"校验失败"排查起来毫无线索。
        // 但绝不回显收到的值 —— args 里可能有明文密码。
        const where = parsed.error.issues
          .slice(0, 4)
          .map((i) => `${i.path.slice(1).join('.') || '(根)'}=${i.code}`)
          .join('; ')
        log.warn(`invalid args for ${channel}: ${parsed.error.message}`)
        throw new Error(`参数校验失败 ${channel} → ${where}`)
      }
      // 用校验后的数据而不是原始 args：zod 会剥掉未声明的字段，
      // 否则 renderer 塞进来的多余键会一路穿到处理器（例如让导出写到任意路径）
      return fn(...(parsed.data as InvokeMap[K]['args']))
    }
    return fn(...(args as InvokeMap[K]['args']))
  })
}

/** 注册高频单向消息处理器（不校验 schema，走热路径） */
export function onSend<K extends keyof SendMap>(channel: K, fn: (payload: SendMap[K]) => void): void {
  ipcMain.on(channel, (event, payload) => {
    assertTrustedSender(event)
    fn(payload as SendMap[K])
  })
}

/** 向主窗口推事件；窗口不存在/已销毁时静默丢弃 */
export function emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}
