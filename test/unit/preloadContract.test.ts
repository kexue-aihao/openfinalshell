import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfsApi } from '../../src/shared/ipc'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS
} from '../../src/shared/ipc'
import { channelsOf } from '../sourceGuard'

const electron = vi.hoisted(() => ({
  exposed: undefined as OfsApi | undefined,
  invoke: vi.fn(async () => undefined),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  postMessage: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: OfsApi) => { electron.exposed = api }
  },
  ipcRenderer: {
    invoke: electron.invoke,
    send: electron.send,
    on: electron.on,
    removeListener: electron.removeListener,
    postMessage: electron.postMessage
  },
  webUtils: { getPathForFile: (file: File) => file.name }
}))

await import('../../src/preload/index')

type PortListener = (event: { data: unknown }) => void

class FakePort {
  readonly posted: unknown[] = []
  readonly listeners = new Set<PortListener>()
  closed = false

  addEventListener(_type: string, listener: PortListener): void { this.listeners.add(listener) }
  removeEventListener(_type: string, listener: PortListener): void { this.listeners.delete(listener) }
  start(): void {}
  postMessage(value: unknown): void { this.posted.push(value) }
  close(): void { this.closed = true }
  dispatch(data: unknown): void {
    for (const listener of this.listeners) listener({ data })
  }
}

class FakeMessageChannel {
  static readonly instances: FakeMessageChannel[] = []
  readonly port1 = new FakePort()
  readonly port2 = new FakePort()

  constructor() { FakeMessageChannel.instances.push(this) }
}

function validFrameBuffer(_sequence: number, width: number, height: number): ArrayBuffer {
  const buffer = new ArrayBuffer(24 + width * height * 4)
  const view = new DataView(buffer)
  view.setUint32(8, width, true)
  view.setUint32(12, height, true)
  view.setUint32(16, width * 4, true)
  view.setUint32(20, width * height * 4, true)
  return buffer
}

const ofs = electron.exposed!
const unsafe = ofs as unknown as {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  send: (channel: string, payload: unknown) => void
  on: (channel: string, listener: (payload: unknown) => void) => () => void
}

beforeEach(() => {
  vi.clearAllMocks()
  FakeMessageChannel.instances.length = 0
  vi.stubGlobal('MessageChannel', FakeMessageChannel)
})

describe('preload runtime contract', () => {
  it('keeps exact runtime allowlists in sync with all three typed channel maps', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(channelsOf('InvokeMap').sort())
    expect([...SEND_CHANNELS].sort()).toEqual(channelsOf('SendMap').sort())
    expect([...EVENT_CHANNELS].sort()).toEqual(channelsOf('EventMap').sort())
  })

  it('rejects unknown channels even when their prefix is otherwise allowed', async () => {
    expect(() => unsafe.invoke('rdp:not-real')).toThrow('blocked ipc channel')
    expect(() => unsafe.send('term:not-real', {})).toThrow('blocked ipc channel')
    expect(() => unsafe.on('session:not-real', () => {})).toThrow('blocked ipc channel')

    await expect(ofs.invoke('app:getVersions')).resolves.toBeUndefined()
    ofs.send('term:input', { termId: 'term-1', data: 'x' })
    ofs.on('rdp:state', () => {})
    expect(electron.invoke).toHaveBeenCalledWith('app:getVersions')
    expect(electron.send).toHaveBeenCalledWith('term:input', { termId: 'term-1', data: 'x' })
    expect(electron.on).toHaveBeenCalledWith('rdp:state', expect.any(Function))
  })

  it('filters inbound frames and only acknowledges the sequence being delivered', () => {
    const listener = vi.fn()
    const dispose = ofs.connectRdpPort('session-1', listener)
    const channel = FakeMessageChannel.instances[0]
    expect(electron.postMessage).toHaveBeenCalledWith(
      'rdp:port',
      { sessionId: 'session-1' },
      [channel.port2]
    )

    channel.port1.dispatch({ kind: 'frame', sequence: 1 })
    channel.port1.dispatch({
      kind: 'frameAck',
      sequence: 1,
      canvasWidth: 640,
      canvasHeight: 480,
      buffer: new ArrayBuffer(16)
    })
    expect(listener).not.toHaveBeenCalled()

    channel.port1.dispatch({
      kind: 'frame',
      sequence: 7,
      canvasWidth: 640,
      canvasHeight: 480,
      buffer: validFrameBuffer(7, 640, 480)
    })
    expect(listener).toHaveBeenCalledTimes(1)
    const ack = listener.mock.calls[0][1] as (sequence: number) => void
    ack(-1)
    ack(8)
    expect(channel.port1.posted).toEqual([])
    ack(7)
    expect(channel.port1.posted).toEqual([{ kind: 'frameAck', sequence: 7 }])

    dispose()
    ack(7)
    expect(channel.port1.posted).toHaveLength(1)
  })

  it('replaces a prior port for the same session without stale cleanup closing the new port', () => {
    const disposeFirst = ofs.connectRdpPort('session-1', () => {})
    const first = FakeMessageChannel.instances[0]
    const disposeSecond = ofs.connectRdpPort('session-1', () => {})
    const second = FakeMessageChannel.instances[1]

    expect(first.port1.closed).toBe(true)
    expect(second.port1.closed).toBe(false)
    disposeFirst()
    expect(second.port1.closed).toBe(false)
    disposeSecond()
    expect(second.port1.closed).toBe(true)
    expect(() => ofs.connectRdpPort('', () => {})).toThrow('invalid RDP session id')
  })
})
