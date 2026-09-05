import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const emit = vi.fn()
const getProfile = vi.fn(() => ({
  id: 'profile-1',
  protocol: 'rdp',
  host: 'rdp.example',
  port: 3389,
  username: 'alice',
  auth: { method: 'password' },
  rdp: { clipboard: false, certificatePolicy: 'prompt' }
}))
type PromptReply = { ok: boolean; answers?: string[]; remember?: boolean }
const promptRequest = vi.fn((_sessionId: string, _kind: string, _payload: unknown, _timeoutMs?: number) =>
  Promise.resolve({ ok: true, answers: ['secret'], remember: false } as PromptReply)
)
const cancelForSession = vi.fn()
const launchRdp = vi.fn()
const rememberRdpPassword = vi.fn()

vi.mock('../../src/main/ipc/registry', () => ({ emit }))
vi.mock('../../src/main/services/i18n', () => ({ t: (key: string) => key }))
vi.mock('../../src/main/store/connections', () => ({ getProfile, rememberRdpPassword, upsertProfile: vi.fn() }))
vi.mock('../../src/main/store/Vault', () => ({ vault: { getSecret: vi.fn(() => null), putSecret: vi.fn(), putSecretIfAvailable: vi.fn(), isAvailable: vi.fn(() => true) } }))
vi.mock('../../src/main/ssh/PromptBroker', () => ({ promptBroker: { request: promptRequest, cancelForSession } }))
vi.mock('../../src/main/services/rdpLaunch', () => ({ launchRdp }))

class FakeWorker extends EventEmitter {
  readonly writes: Buffer[] = []
  readonly stdin = {
    writable: true,
    write: (chunk: Buffer) => { this.writes.push(Buffer.from(chunk)); return true },
    end: vi.fn()
  }
  readonly stdout = Object.assign(new EventEmitter(), {
    isPaused: vi.fn(() => false),
    pause: vi.fn(),
    resume: vi.fn()
  })
  readonly stderr = new EventEmitter()
  killed = false
  kill = vi.fn(() => { this.killed = true; this.emit('exit', null, 'SIGTERM'); return true })
}

class FakePort extends EventEmitter {
  readonly posted: Array<{ kind: string; sequence: number }> = []
  closed = false
  started = false

  postMessage(value: { kind: string; sequence: number }): void { this.posted.push(value) }
  close(): void { this.closed = true }
  start(): void { this.started = true }
  ack(sequence: number): void { this.emit('message', { data: { kind: 'frameAck', sequence } }) }
  remoteClose(): void { this.emit('close') }
}

let currentWorker = new FakeWorker()
const spawnedWorkers: FakeWorker[] = []
const spawn = vi.fn(() => {
  currentWorker = new FakeWorker()
  spawnedWorkers.push(currentWorker)
  return currentWorker
})
vi.mock('node:child_process', () => ({ spawn }))

function packet(type: number, requestId: number, payload: Buffer): Buffer {
  const out = Buffer.alloc(16 + payload.length)
  out.write('OFSR', 0, 'ascii')
  out.writeUInt16LE(1, 4)
  out.writeUInt8(type, 6)
  out.writeUInt32LE(payload.length, 8)
  out.writeUInt32LE(requestId, 12)
  payload.copy(out, 16)
  return out
}

function jsonPacket(type: number, requestId: number, value: object): Buffer {
  return packet(type, requestId, Buffer.from(JSON.stringify(value)))
}

function framePacket(sequence: number, width = 640, height = 480): Buffer {
  const canvasWidth = Math.max(320, width)
  const canvasHeight = Math.max(320, height)
  const bytes = Buffer.alloc(canvasWidth * canvasHeight * 4, 0x22)
  const header = Buffer.alloc(16 + 24)
  header.writeUInt32LE(canvasWidth, 0)
  header.writeUInt32LE(canvasHeight, 4)
  header.writeUInt32LE(sequence, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(0, 20)
  header.writeUInt32LE(canvasWidth, 24)
  header.writeUInt32LE(canvasHeight, 28)
  header.writeUInt32LE(canvasWidth * 4, 32)
  header.writeUInt32LE(bytes.length, 36)
  return packet(0x30, 0, Buffer.concat([header, bytes]))
}

async function openReady() {
  const { RdpSessionManager } = await import('../../src/main/rdp/RdpSessionManager')
  const manager = new RdpSessionManager()
  const { sessionId } = manager.open('profile-1', { width: 1280, height: 720, dpi: 96 })
  currentWorker.stdout.emit('data', jsonPacket(0x01, 0, {
    op: 'hello', protocol: 1, workerVersion: 'test', capabilities: ['framebuffer', 'input', 'resize', 'clipboard']
  }))
  currentWorker.stdout.emit('data', jsonPacket(0x20, 0, { op: 'state', state: 'ready' }))
  await Promise.resolve()
  return { manager, sessionId }
}

describe('RdpSessionManager protocol/state behavior', () => {
  beforeEach(() => {
    vi.resetModules()
    emit.mockClear(); getProfile.mockClear(); promptRequest.mockClear(); cancelForSession.mockClear(); launchRdp.mockClear(); rememberRdpPassword.mockClear()
    spawn.mockClear(); spawnedWorkers.length = 0
    process.env.OFS_RDP_WORKER = process.execPath
  })

  it('returns a failed session identity when the packaged worker is missing so fallback remains explicit', async () => {
    process.env.OFS_RDP_WORKER = 'E:\\openfinalshell\\missing-rdp-worker.exe'
    const { RdpSessionManager } = await import('../../src/main/rdp/RdpSessionManager')
    const manager = new RdpSessionManager()
    const { sessionId } = manager.open('profile-1', { width: 1280, height: 720, dpi: 96 })
    expect(sessionId).toBeTruthy()
    expect(spawn).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('rdp:state', expect.objectContaining({
      sessionId,
      state: 'failed',
      errorCode: 'WORKER_MISSING'
    }))
    await manager.systemFallback(sessionId)
    expect(launchRdp).toHaveBeenCalledWith(expect.objectContaining({ id: 'profile-1', host: 'rdp.example' }))
  })

  it('maps synchronous worker spawn failures to WORKER_START_FAILED without losing the session', async () => {
    spawn.mockImplementationOnce(() => { throw new Error('spawn failed') })
    const { RdpSessionManager } = await import('../../src/main/rdp/RdpSessionManager')
    const manager = new RdpSessionManager()
    const { sessionId } = manager.open('profile-1', { width: 1280, height: 720, dpi: 96 })
    expect(emit).toHaveBeenCalledWith('rdp:state', expect.objectContaining({
      sessionId,
      state: 'failed',
      errorCode: 'WORKER_START_FAILED'
    }))
    await manager.systemFallback(sessionId)
    expect(launchRdp).toHaveBeenCalled()
  })

  it('rejects system fallback while an embedded Worker is active', async () => {
    const { manager, sessionId } = await openReady()

    await expect(manager.systemFallback(sessionId)).rejects.toThrow('err.rdp.fallbackNotAllowed')
    expect(launchRdp).not.toHaveBeenCalled()
  })

  it('does not expose ready or accept input until the first valid frame', async () => {
    const { manager, sessionId } = await openReady()
    expect(emit.mock.calls.some(([channel, value]) => channel === 'rdp:state' && value.state === 'ready')).toBe(false)
    expect(() => manager.input(sessionId, { kind: 'key', scanCode: 30, pressed: true })).toThrow('SESSION_NOT_READY')
    currentWorker.stdout.emit('data', framePacket(1))
    expect(emit.mock.calls.some(([channel, value]) => channel === 'rdp:state' && value.state === 'ready')).toBe(true)
    expect(() => manager.input(sessionId, { kind: 'key', scanCode: 30, pressed: true })).not.toThrow()
  })

  it('bounds unacknowledged port frames at two and flushes only the latest stalled frame on ACK', async () => {
    const { manager, sessionId } = await openReady()
    const port = new FakePort()
    manager.attachPort(sessionId, port as never)

    currentWorker.stdout.emit('data', Buffer.concat([
      framePacket(1, 4, 4),
      framePacket(2, 4, 4),
      framePacket(3, 4, 4),
      framePacket(4, 4, 4)
    ]))

    expect(port.started).toBe(true)
    expect(port.posted.map(({ sequence }) => sequence)).toEqual([1, 2])
    expect(currentWorker.stdout.pause).toHaveBeenCalledTimes(1)

    port.ack(1)
    expect(port.posted.map(({ sequence }) => sequence)).toEqual([1, 2, 4])
    expect(currentWorker.stdout.resume).toHaveBeenCalledTimes(1)
  })

  it('recovers a stalled renderer when a frame ACK times out after 500ms', async () => {
    vi.useFakeTimers()
    try {
      const { manager, sessionId } = await openReady()
      const port = new FakePort()
      manager.attachPort(sessionId, port as never)
      currentWorker.stdout.emit('data', Buffer.concat([
        framePacket(1, 4, 4),
        framePacket(2, 4, 4),
        framePacket(3, 4, 4)
      ]))

      expect(port.posted.map(({ sequence }) => sequence)).toEqual([1, 2])
      expect(currentWorker.stdout.pause).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(499)
      expect(port.posted.map(({ sequence }) => sequence)).toEqual([1, 2])
      vi.advanceTimersByTime(1)
      expect(port.posted.map(({ sequence }) => sequence)).toEqual([1, 2, 3])
      expect(currentWorker.stdout.resume).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores ACK and close events from a replaced MessagePort', async () => {
    const { manager, sessionId } = await openReady()
    const oldPort = new FakePort()
    const newPort = new FakePort()
    manager.attachPort(sessionId, oldPort as never)
    currentWorker.stdout.emit('data', Buffer.concat([
      framePacket(1, 4, 4),
      framePacket(2, 4, 4),
      framePacket(3, 4, 4)
    ]))

    manager.attachPort(sessionId, newPort as never)
    expect(oldPort.closed).toBe(true)
    expect(newPort.posted.map(({ sequence }) => sequence)).toEqual([3])
    currentWorker.stdout.emit('data', Buffer.concat([
      framePacket(4, 4, 4),
      framePacket(5, 4, 4)
    ]))
    const pauseCount = currentWorker.stdout.pause.mock.calls.length
    const resumeCount = currentWorker.stdout.resume.mock.calls.length

    oldPort.ack(3)
    oldPort.remoteClose()
    expect(newPort.posted.map(({ sequence }) => sequence)).toEqual([3, 4])
    expect(currentWorker.stdout.pause).toHaveBeenCalledTimes(pauseCount)
    expect(currentWorker.stdout.resume).toHaveBeenCalledTimes(resumeCount)

    newPort.ack(3)
    expect(newPort.posted.map(({ sequence }) => sequence)).toEqual([3, 4, 5])
    expect(currentWorker.stdout.resume).toHaveBeenCalledTimes(resumeCount + 1)
  })

  it('rejects a mock worker hello when a real FreeRDP backend is required', async () => {
    const { RdpSessionManager } = await import('../../src/main/rdp/RdpSessionManager')
    const manager = new RdpSessionManager({ requireFreerdpWorker: true })
    const { sessionId } = manager.open('profile-1', { width: 1280, height: 720, dpi: 96 })
    currentWorker.stdout.emit('data', jsonPacket(0x01, 0, {
      op: 'hello',
      protocol: 1,
      workerVersion: 'mock',
      capabilities: ['mock', 'framebuffer', 'input', 'resize', 'clipboard']
    }))

    expect(emit).toHaveBeenCalledWith('rdp:state', expect.objectContaining({
      sessionId,
      state: 'failed',
      errorCode: 'PROTOCOL_MISMATCH'
    }))
    expect(currentWorker.writes.some((bytes) => bytes[6] === 0x10)).toBe(false)
  })

  it('waits for worker close before publishing closed and removes only after user close', async () => {
    const { manager, sessionId } = await openReady()
    currentWorker.stdout.emit('data', framePacket(1))
    const closing = manager.close(sessionId)
    await Promise.resolve()
    expect(emit.mock.calls.some(([channel, value]) => channel === 'rdp:state' && value.state === 'closing')).toBe(true)
    expect(emit.mock.calls.some(([channel, value]) => channel === 'rdp:state' && value.state === 'closed')).toBe(false)
    expect(currentWorker.writes.some((bytes) => bytes[6] === 0x12 && bytes.toString('utf8').includes('"reason":"user"'))).toBe(true)
    currentWorker.stdout.emit('data', jsonPacket(0x20, 0, { op: 'state', state: 'closed' }))
    await closing
    expect(emit.mock.calls.some(([channel, value]) => channel === 'rdp:state' && value.state === 'closed')).toBe(true)
  })

  it('keeps failed session identity for explicit reconnect and drops old worker events', async () => {
    const { manager, sessionId } = await openReady()
    const oldWorker = currentWorker
    oldWorker.emit('exit', 1, null)
    await Promise.resolve()
    await manager.reconnect(sessionId)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls.some(([channel, value]) => channel === 'rdp:state' && value.state === 'reconnecting')).toBe(true)
    const stateCallCount = emit.mock.calls.length
    oldWorker.stdout.emit('data', framePacket(99))
    oldWorker.emit('exit', 1, 'SIGTERM')
    expect(emit.mock.calls).toHaveLength(stateCallCount)
  })

  it('keeps profile data available for explicit system fallback after failure', async () => {
    const { manager, sessionId } = await openReady()
    currentWorker.emit('exit', 1, null)
    await manager.systemFallback(sessionId)
    expect(launchRdp).toHaveBeenCalledWith(expect.objectContaining({ id: 'profile-1', host: 'rdp.example' }))
  })

  it('maps every unexpected worker exit to WORKER_CRASHED', async () => {
    await openReady()
    currentWorker.emit('exit', 0, null)
    expect(emit).toHaveBeenCalledWith('rdp:state', expect.objectContaining({
      state: 'failed',
      errorCode: 'WORKER_CRASHED'
    }))
  })

  it('maps a runtime Worker error to WORKER_CRASHED, while startup errors stay WORKER_START_FAILED', async () => {
    await openReady()
    currentWorker.emit('error', new Error('runtime pipe failure'))
    expect(emit).toHaveBeenCalledWith('rdp:state', expect.objectContaining({
      state: 'failed',
      errorCode: 'WORKER_CRASHED'
    }))
  })

  it.each(['end', 'close'])('maps unexpected stdout %s to WORKER_CRASHED', async (event) => {
    await openReady()
    currentWorker.stdout.emit(event)
    expect(emit).toHaveBeenCalledWith('rdp:state', expect.objectContaining({
      state: 'failed',
      errorCode: 'WORKER_CRASHED'
    }))
  })

  it('does not report a worker crash when stdout closes during an active close', async () => {
    const { manager, sessionId } = await openReady()
    let settled = false
    const closing = manager.close(sessionId)
    void closing.then(() => { settled = true })
    currentWorker.stdout.emit('close')
    await Promise.resolve()
    expect(settled).toBe(false)
    currentWorker.emit('exit', 0, null)
    await closing
    expect(emit.mock.calls.some(([channel, value]) => channel === 'rdp:state' && value.errorCode === 'WORKER_CRASHED')).toBe(false)
  })

  it('freezes strict certificate policy in START and rejects prompts without PromptHost', async () => {
    getProfile.mockReturnValueOnce({
      id: 'profile-1',
      protocol: 'rdp',
      host: 'rdp.example',
      port: 3389,
      username: 'alice',
      auth: { method: 'password' },
      rdp: { clipboard: false, certificatePolicy: 'strict' }
    })
    await openReady()
    const start = currentWorker.writes.find((bytes) => bytes[6] === 0x10)
    expect(start).toBeDefined()
    expect(JSON.parse(start!.subarray(16).toString('utf8')).features).toEqual({
      clipboard: false,
      certificatePolicy: 'strict'
    })

    currentWorker.stdout.emit('data', jsonPacket(0x21, 41, {
      op: 'prompt',
      kind: 'certificate',
      requestId: 41,
      payload: {
        host: 'rdp.example',
        port: 3389,
        subject: 'CN=rdp.example',
        issuer: 'CN=test-ca',
        fingerprintSha256: '00:11',
        changed: false
      }
    }))

    expect(promptRequest.mock.calls.some(([, kind]) => kind === 'rdp-certificate')).toBe(false)
    const response = currentWorker.writes.find((bytes) => bytes[6] === 0x11 && bytes.readUInt32LE(12) === 41)
    expect(response).toBeDefined()
    expect(JSON.parse(response!.subarray(16).toString('utf8'))).toEqual({
      op: 'certificate',
      requestId: 41,
      accept: false
    })
  })

  it('drops duplicate certificate prompts for the same worker request id', async () => {
    const { manager } = await openReady()
    const prompt = jsonPacket(0x21, 77, {
      op: 'prompt',
      kind: 'certificate',
      requestId: 77,
      payload: {
        host: 'rdp.example',
        port: 3389,
        subject: 'CN=rdp.example',
        issuer: 'CN=test-ca',
        fingerprintSha256: '00:11',
        changed: false
      }
    })
    currentWorker.stdout.emit('data', prompt)
    currentWorker.stdout.emit('data', prompt)
    await Promise.resolve()
    currentWorker.stdout.emit('data', prompt)

    expect(manager).toBeDefined()
    expect(promptRequest.mock.calls.filter(([, kind]) => kind === 'rdp-certificate')).toHaveLength(1)
    expect(currentWorker.writes.filter((bytes) => bytes[6] === 0x11 && bytes.readUInt32LE(12) === 77)).toHaveLength(1)
  })

  it('persists remembered RDP prompts via the RDP Vault ref path and still sends the one-shot credential', async () => {
    promptRequest.mockResolvedValueOnce({ ok: true, answers: ['secret'], remember: true })
    await openReady()
    await Promise.resolve()
    expect(rememberRdpPassword).toHaveBeenCalledWith('profile-1', 'secret')
    const credential = currentWorker.writes.find((bytes) => bytes[6] === 0x11)
    expect(credential).toBeDefined()
    expect(JSON.parse(credential!.subarray(16).toString('utf8'))).toEqual({
      op: 'credential',
      kind: 'password',
      value: 'secret'
    })
  })

  it('reports a canceled RDP password prompt with the stable CANCELED code', async () => {
    promptRequest.mockResolvedValueOnce({ ok: false })
    await openReady()
    await Promise.resolve()
    expect(emit).toHaveBeenCalledWith('rdp:state', expect.objectContaining({
      state: 'failed',
      errorCode: 'CANCELED'
    }))
  })

  it('uses reconnect and shutdown close reasons before replacing or quitting', async () => {
    const { manager, sessionId } = await openReady()
    const oldWorker = currentWorker
    const reconnecting = manager.reconnect(sessionId)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(oldWorker.writes.some((bytes) => bytes[6] === 0x12 && bytes.toString('utf8').includes('"reason":"reconnect"'))).toBe(true)
    oldWorker.stdout.emit('data', jsonPacket(0x20, 0, { op: 'state', state: 'closed' }))
    await reconnecting
    expect(spawn).toHaveBeenCalledTimes(2)
    manager.closeAll()
    expect(currentWorker.writes.some((bytes) => bytes[6] === 0x12 && bytes.toString('utf8').includes('"reason":"shutdown"'))).toBe(true)
  })

  it('waits for all worker close acknowledgements in closeAll', async () => {
    const { manager } = await openReady()
    let settled = false
    const closing = manager.closeAll().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    currentWorker.stdout.emit('data', jsonPacket(0x20, 0, { op: 'state', state: 'closed' }))
    await closing
    expect(settled).toBe(true)
  })

  it('coalesces resize to 100ms and enforces 320 edge plus pixel ceiling', async () => {
    vi.useFakeTimers()
    try {
      const { manager, sessionId } = await openReady()
      currentWorker.stdout.emit('data', framePacket(1))
      manager.resize(sessionId, { width: 8192, height: 8192, dpi: 500 })
      manager.resize(sessionId, { width: 1, height: 1, dpi: 1 })
      const resizeWrites = () => currentWorker.writes.filter((bytes) => bytes[6] === 0x13).map((bytes) => JSON.parse(bytes.subarray(16).toString('utf8')))
      expect(resizeWrites()).toHaveLength(1)
      expect(resizeWrites()[0].width * resizeWrites()[0].height).toBeLessThanOrEqual(16_777_216)
      vi.advanceTimersByTime(100)
      expect(resizeWrites()).toHaveLength(2)
      expect(resizeWrites()[1].width).toBe(320)
      expect(resizeWrites()[1].height).toBe(320)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a queued resize when graceful close begins', async () => {
    vi.useFakeTimers()
    try {
      const { manager, sessionId } = await openReady()
      currentWorker.stdout.emit('data', framePacket(1))
      manager.resize(sessionId, { width: 640, height: 480, dpi: 96 })
      manager.resize(sessionId, { width: 800, height: 600, dpi: 96 })
      const closing = manager.close(sessionId)
      vi.advanceTimersByTime(100)
      expect(currentWorker.writes.filter((bytes) => bytes[6] === 0x13)).toHaveLength(1)
      currentWorker.stdout.emit('data', jsonPacket(0x20, 0, { op: 'state', state: 'closed' }))
      await closing
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes a remote clipboard request with one correlated request id', async () => {
    getProfile.mockReturnValueOnce({
      id: 'profile-1', protocol: 'rdp', host: 'rdp.example', port: 3389,
      username: 'alice', auth: { method: 'password' },
      rdp: { clipboard: true, certificatePolicy: 'prompt' }
    })
    const { manager, sessionId } = await openReady()
    currentWorker.stdout.emit('data', framePacket(1))
    manager.clipboardGet(sessionId)
    const request = currentWorker.writes.find((bytes) => bytes[6] === 0x17)
    expect(request).toBeDefined()
    const requestId = request!.readUInt32LE(12)
    expect(requestId).toBeGreaterThan(0)
    expect(JSON.parse(request!.subarray(16).toString('utf8'))).toEqual({
      op: 'clipboardGet',
      requestId
    })
  })

  it('does not send or publish clipboard data when the profile disables clipboard', async () => {
    const { manager, sessionId } = await openReady()
    currentWorker.stdout.emit('data', framePacket(1))

    expect(() => manager.clipboardSet(sessionId, 'local')).toThrow('UNSUPPORTED')
    expect(() => manager.clipboardGet(sessionId)).toThrow('UNSUPPORTED')
    currentWorker.stdout.emit('data', jsonPacket(0x22, 0, {
      op: 'clipboardData', mime: 'text/plain', text: 'remote'
    }))

    expect(currentWorker.writes.some((bytes) => bytes[6] === 0x16 || bytes[6] === 0x17)).toBe(false)
    expect(emit.mock.calls.some(([channel]) => channel === 'rdp:clipboard')).toBe(false)
  })

  it('serializes renderer input as the frozen worker protocol payloads', async () => {
    const { manager, sessionId } = await openReady()
    currentWorker.stdout.emit('data', framePacket(1))
    manager.input(sessionId, { kind: 'key', scanCode: 30, pressed: true, extended: false, unicode: 97 })
    manager.input(sessionId, { kind: 'pointer', x: 10, y: 20, buttons: 1, wheelX: 0, wheelY: -120 })

    const key = currentWorker.writes.find((bytes) => bytes[6] === 0x14)
    const pointer = currentWorker.writes.find((bytes) => bytes[6] === 0x15)
    expect(key).toBeDefined()
    expect(pointer).toBeDefined()
    expect(JSON.parse(key!.subarray(16).toString('utf8'))).toEqual({
      op: 'key',
      scanCode: 30,
      pressed: true,
      extended: false,
      unicode: 97
    })
    expect(JSON.parse(pointer!.subarray(16).toString('utf8'))).toEqual({
      op: 'pointer',
      x: 10,
      y: 20,
      buttons: 1,
      wheelX: 0,
      wheelY: -120
    })
  })
})
