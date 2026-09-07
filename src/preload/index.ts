import { clipboard, contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
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

function splitClipboardPaths(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split('\u0000').filter((value) => value.length > 0)
}

function readDropFiles(buffer: Buffer): string[] {
  // Windows CF_HDROP is a DROPFILES header followed by a double-null
  // terminated path list. Explorer normally uses the Unicode form.
  if (buffer.length < 20) return []
  const offset = buffer.readUInt32LE(0)
  const wide = buffer.readUInt32LE(16) !== 0
  if (offset < 20 || offset >= buffer.length || (wide && (offset & 1) !== 0)) return []
  const list = buffer.subarray(offset)
  if (wide) {
    const evenLength = list.length - (list.length % 2)
    return splitClipboardPaths(list.subarray(0, evenLength).toString('utf16le'))
  }
  return splitClipboardPaths(list.toString('latin1'))
}

function readClipboardFilePaths(): string[] {
  if (process.platform !== 'win32') return []
  const formats = clipboard.availableFormats()
  const candidates = ['CF_HDROP', 'FileNameW', 'FileName'].filter((format) =>
    format === 'CF_HDROP' || formats.includes(format))
  for (const format of candidates) {
    try {
      const buffer = clipboard.readBuffer(format)
      if (buffer.length === 0) continue
      if (format === 'CF_HDROP') {
        const paths = readDropFiles(buffer)
        if (paths.length > 0) return paths
        continue
      }
      const text = format === 'FileNameW'
        ? buffer.toString('utf16le').replace(/^\uFEFF/, '')
        : buffer.toString('latin1')
      // Electron normally returns null-separated names without DROPFILES, but
      // accepting the native header keeps older Electron/Windows builds usable.
      const offset = format === 'FileNameW' && buffer.length >= 20 &&
        buffer.readUInt32LE(0) >= 20 && buffer.readUInt32LE(0) < buffer.length
        ? Math.floor(buffer.readUInt32LE(0) / 2)
        : 0
      const paths = splitClipboardPaths(text.slice(offset))
      if (paths.length > 0) return paths
    } catch {
      // A format can disappear between availableFormats() and readBuffer().
      // Continue with the other native file representations.
    }
  }
  return []
}

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
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getClipboardFilePaths: readClipboardFilePaths
}

contextBridge.exposeInMainWorld('ofs', ofs)
