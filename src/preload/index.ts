import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { CHANNEL_PREFIXES, type OfsApi } from '@shared/ipc'

/** channel 前缀白名单：preload 是 renderer 能力的唯一边界 */
function assertChannel(channel: string): void {
  if (!CHANNEL_PREFIXES.some((p) => channel.startsWith(p))) {
    throw new Error(`blocked ipc channel: ${channel}`)
  }
}

const ofs: OfsApi = {
  invoke: (channel, ...args) => {
    assertChannel(channel)
    return ipcRenderer.invoke(channel, ...args)
  },
  send: (channel, payload) => {
    assertChannel(channel)
    ipcRenderer.send(channel, payload)
  },
  on: (channel, listener) => {
    assertChannel(channel)
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void =>
      listener(payload as Parameters<typeof listener>[0])
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  // 拖拽上传：File → 本地绝对路径（Electron ≥32 只能在 preload 里取）
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('ofs', ofs)
