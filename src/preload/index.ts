import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  RDP_PORT_CHANNEL,
  SEND_CHANNELS,
  type OfsApi
} from '@shared/ipc'
import {
  isRdpPortFrameMessage,
  type RdpPortFrameMessage,
  type RdpPortMessage,
  type SessionId
} from '@shared/types'

/** Exact channel allowlists: a known prefix alone does not grant renderer access. */
function assertChannel(channel: string, allowed: ReadonlySet<string>): void {
  if (!allowed.has(channel)) {
    throw new Error(`blocked ipc channel: ${channel}`)
  }
}

const rdpPortDisposers = new Map<SessionId, () => void>()

const ofs: OfsApi = {
  invoke: (channel, ...args) => {
    assertChannel(channel, INVOKE_CHANNELS)
    return ipcRenderer.invoke(channel, ...args)
  },
  send: (channel, payload) => {
    assertChannel(channel, SEND_CHANNELS)
    ipcRenderer.send(channel, payload)
  },
  on: (channel, listener) => {
    assertChannel(channel, EVENT_CHANNELS)
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void =>
      listener(payload as Parameters<typeof listener>[0])
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  connectRdpPort: (sessionId: SessionId, listener: (payload: RdpPortFrameMessage, ack?: (sequence: number) => void) => void) => {
    if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 200) {
      throw new Error('invalid RDP session id')
    }
    rdpPortDisposers.get(sessionId)?.()
    const channel = new MessageChannel()
    let disposed = false
    const onMessage = (event: Event): void => {
      const payload: unknown = (event as MessageEvent).data
      // The transferred port is a privilege boundary too: acknowledgements,
      // clipboard objects and malformed frame metadata never reach renderer.
      if (!isRdpPortFrameMessage(payload)) return
      listener(payload, (sequence: number) => {
        if (disposed || sequence !== payload.sequence) return
        channel.port1.postMessage({ kind: 'frameAck', sequence } satisfies RdpPortMessage)
      })
    }
    channel.port1.addEventListener('message', onMessage)
    channel.port1.start()
    // Only this fixed channel is accepted by main; the renderer cannot choose
    // an arbitrary IPC channel or pass a filesystem/worker path.
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      channel.port1.removeEventListener('message', onMessage)
      channel.port1.close()
      if (rdpPortDisposers.get(sessionId) === dispose) rdpPortDisposers.delete(sessionId)
    }
    rdpPortDisposers.set(sessionId, dispose)
    try {
      ipcRenderer.postMessage(RDP_PORT_CHANNEL, { sessionId }, [channel.port2])
    } catch (error) {
      dispose()
      throw error
    }
    return dispose
  },
  // 拖拽上传：File → 本地绝对路径（Electron ≥32 只能在 preload 里取）
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('ofs', ofs)
