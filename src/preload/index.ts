import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
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
  }
}

contextBridge.exposeInMainWorld('ofs', ofs)
