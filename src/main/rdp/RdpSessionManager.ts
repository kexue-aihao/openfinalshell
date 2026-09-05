import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import electron from 'electron'
import type { MessagePortMain } from 'electron'
import {
  clampRdpDisplaySize,
  type ConnectionProfile,
  type RdpDisplaySize,
  type RdpErrorCode,
  type RdpFrame,
  type RdpInput,
  type RdpSessionState,
  type SessionId,
  parseRdpFrameV1,
  RDP_MAX_FRAME_BYTES
} from '@shared/types'
import { getProfile, rememberRdpPassword } from '../store/connections'
import { vault } from '../store/Vault'
import { promptBroker } from '../ssh/PromptBroker'
import { emit } from '../ipc/registry'
import { t } from '../services/i18n'
import { launchRdp } from '../services/rdpLaunch'

const MAGIC = Buffer.from('OFSR')
const VERSION = 1
const MAX_PAYLOAD = RDP_MAX_FRAME_BYTES
const HEADER_SIZE = 16
const MAX_BUFFERED_BYTES = MAX_PAYLOAD + HEADER_SIZE + 128 * 1024
const ACK_TIMEOUT_MS = 500
const CLOSE_TIMEOUT_MS = 2000
const RESIZE_INTERVAL_MS = 100
const DEFAULT_DISPLAY: RdpDisplaySize = { width: 1280, height: 720, dpi: 96 }
const REQUIRED_CAPABILITIES = new Set(['framebuffer', 'input', 'resize'])
const KNOWN_CAPABILITIES = new Set(['framebuffer', 'input', 'resize', 'clipboard', 'mock', 'freerdp'])
const WORKER_ERROR_CODES = new Set([
  'AUTH_FAILED', 'CERTIFICATE_REJECTED', 'NETWORK_ERROR', 'PROTOCOL_ERROR',
  'SESSION_NOT_READY', 'UNSUPPORTED', 'WORKER_CRASHED', 'CANCELED'
])
const WORKER_STATES = new Set<RdpSessionState>([
  'connecting', 'authenticating', 'verifying', 'ready', 'failed', 'closing', 'closed'
])

interface FrozenRdpProfile {
  id: string
  fallbackProfile: ConnectionProfile
  host: string
  port: number
  username: string
  domain: string
  passwordRef?: string
  clipboard: boolean
  certificatePolicy: 'prompt' | 'strict'
}

interface Session {
  id: SessionId
  profile: FrozenRdpProfile
  display: RdpDisplaySize
  worker?: ChildProcessWithoutNullStreams
  inputBuffer: Buffer
  processEnded: boolean
  state: RdpSessionState
  helloReceived: boolean
  workerReady: boolean
  firstFrameReceived: boolean
  requestId: number
  port?: MessagePortMain
  pendingPortFrames: Map<number, NodeJS.Timeout>
  latestFrame?: RdpFrame
  stdoutPaused: boolean
  lastFrameSequence: number
  lastResizeSentAt: number
  pendingResize?: RdpDisplaySize
  resizeTimer?: NodeJS.Timeout
  closeReason?: 'user' | 'reconnect' | 'shutdown' | 'failure'
  closeTimer?: NodeJS.Timeout
  closeCompleted: boolean
  removeWhenClosed: boolean
  closeWaiters: Array<() => void>
  failureCode?: RdpErrorCode
  certificatePolicy: 'prompt' | 'strict'
  pendingCertificateRequests: Set<number>
  seenCertificateRequests: Set<number>
}

interface RdpSessionManagerOptions {
  requireFreerdpWorker?: boolean
}

function defaultRequireFreerdpWorker(): boolean {
  const app = (electron as unknown as { app?: { isPackaged?: boolean } } | undefined)?.app
  return app?.isPackaged === true
}

function workerPath(): string {
  const override = process.env['OFS_RDP_WORKER']
  // Test/dev harnesses may point at a locally compiled mock. Packaged builds
  // always resolve the executable from resources so an inherited environment
  // variable cannot redirect a user connection to an arbitrary binary.
  if (override && (process.env.NODE_ENV === 'test' || process.env.ELECTRON_RENDERER_URL)) return override
  const exe = process.platform === 'win32' ? 'ofs-rdp-worker.exe' : 'ofs-rdp-worker'
  return join(process.resourcesPath, 'rdp-worker', exe)
}

function frame(type: number, requestId: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(HEADER_SIZE + payload.length)
  MAGIC.copy(out, 0)
  out.writeUInt16LE(VERSION, 4)
  out.writeUInt8(type, 6)
  out.writeUInt8(0, 7)
  out.writeUInt32LE(payload.length, 8)
  out.writeUInt32LE(requestId >>> 0, 12)
  payload.copy(out, HEADER_SIZE)
  return out
}

function jsonFrame(type: number, requestId: number, value: Record<string, unknown>): Buffer {
  return frame(type, requestId, Buffer.from(JSON.stringify(value), 'utf8'))
}

function parseJsonObject(payload: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload.toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function stableWorkerError(value: unknown): RdpErrorCode {
  return typeof value === 'string' && WORKER_ERROR_CODES.has(value)
    ? value as RdpErrorCode
    : 'NETWORK_ERROR'
}

function errorDescription(errorCode: RdpErrorCode): string {
  const descriptions = {
    AUTH_FAILED: t('err.rdp.authFailed'),
    CERTIFICATE_REJECTED: t('err.rdp.certificateRejected'),
    NETWORK_ERROR: t('err.rdp.networkError'),
    PROTOCOL_ERROR: t('err.rdp.protocolError'),
    PROTOCOL_MISMATCH: t('err.rdp.protocolMismatch'),
    SESSION_NOT_READY: t('err.rdp.sessionNotReady'),
    CANCELED: t('err.rdp.canceled'),
    UNSUPPORTED: t('err.rdp.unsupported'),
    WORKER_CRASHED: t('err.rdp.workerCrashed'),
    WORKER_MISSING: t('err.rdp.workerMissing'),
    WORKER_START_FAILED: t('err.rdp.workerStartFailed')
  } satisfies Record<RdpErrorCode, string>
  return descriptions[errorCode]
}

export class RdpSessionManager {
  private readonly sessions = new Map<SessionId, Session>()
  private readonly requireFreerdpWorker: boolean

  constructor(options: RdpSessionManagerOptions = {}) {
    this.requireFreerdpWorker = options.requireFreerdpWorker ?? defaultRequireFreerdpWorker()
  }

  private isCurrent(session: Session): boolean {
    return this.sessions.get(session.id) === session
  }

  private isRunning(session: Session): boolean {
    return this.isCurrent(session) && !!session.worker && !session.processEnded && !session.closeReason
  }

  private nextRequestId(session: Session): number {
    const requestId = session.requestId
    session.requestId = requestId === 0xffffffff ? 1 : requestId + 1
    return requestId
  }

  private emitState(session: Session, state: RdpSessionState, errorCode?: RdpErrorCode): void {
    if (!this.isCurrent(session)) return
    session.state = state
    emit('rdp:state', {
      sessionId: session.id,
      state,
      ...(errorCode ? { errorCode, error: errorDescription(errorCode) } : {})
    })
  }

  private write(session: Session, type: number, requestId: number, payload: Record<string, unknown>, allowClosing = false): boolean {
    if (!this.isCurrent(session) || !session.worker || session.processEnded || (!allowClosing && session.closeReason) || !session.worker.stdin.writable) return false
    try {
      session.worker.stdin.write(jsonFrame(type, requestId, payload))
      return true
    } catch {
      if (session.closeReason) this.finishClose(session, true)
      else this.fail(session, 'WORKER_CRASHED')
      return false
    }
  }

  private clearFrameLedger(session: Session): void {
    for (const timer of session.pendingPortFrames.values()) clearTimeout(timer)
    session.pendingPortFrames.clear()
  }

  private clearResizeTimer(session: Session): void {
    if (session.resizeTimer) clearTimeout(session.resizeTimer)
    session.resizeTimer = undefined
    session.pendingResize = undefined
  }

  private pauseStdout(session: Session): void {
    if (session.stdoutPaused || !this.isRunning(session) || !session.worker) return
    session.stdoutPaused = true
    session.worker.stdout.pause()
  }

  private resumeStdout(session: Session): void {
    if (!session.stdoutPaused || !this.isRunning(session) || !session.worker || !session.port || session.latestFrame) return
    session.stdoutPaused = false
    session.worker.stdout.resume()
    this.consumeFrames(session)
  }

  private expireFrame(session: Session, sequence: number): void {
    if (!this.isRunning(session) || !session.pendingPortFrames.has(sequence)) return
    session.pendingPortFrames.delete(sequence)
    this.flushLatestFrame(session)
    this.resumeStdout(session)
  }

  private sendToPort(session: Session, parsed: RdpFrame): void {
    const port = session.port
    if (!port || !this.isRunning(session)) {
      session.latestFrame = parsed
      this.pauseStdout(session)
      return
    }
    const copied = Uint8Array.from(parsed.data)
    const buffer = copied.buffer
    const timer = setTimeout(() => this.expireFrame(session, parsed.sequence), ACK_TIMEOUT_MS)
    timer.unref()
    session.pendingPortFrames.set(parsed.sequence, timer)
    try {
      // Electron accepts ArrayBuffer in a transfer list. Its current declaration
      // is narrower than the runtime API, hence the local cast.
      port.postMessage({
        kind: 'frame',
        sequence: parsed.sequence,
        canvasWidth: parsed.canvasWidth,
        canvasHeight: parsed.canvasHeight,
        buffer
      }, [buffer as unknown as MessagePortMain])
    } catch {
      clearTimeout(timer)
      session.pendingPortFrames.delete(parsed.sequence)
      session.latestFrame = parsed
      this.pauseStdout(session)
    }
  }

  private queueFrame(session: Session, parsed: RdpFrame): void {
    if (!this.isRunning(session)) return
    if (parsed.sequence <= session.lastFrameSequence) return
    session.lastFrameSequence = parsed.sequence
    if (!session.port || session.pendingPortFrames.size >= 2) {
      // Only one replacement frame is retained locally. It replaces an older
      // unsent frame so a stalled renderer observes the latest desktop state.
      session.latestFrame = parsed
      this.pauseStdout(session)
      return
    }
    this.sendToPort(session, parsed)
  }

  private flushLatestFrame(session: Session): void {
    if (!this.isRunning(session) || !session.port || !session.latestFrame || session.pendingPortFrames.size >= 2) return
    const latest = session.latestFrame
    session.latestFrame = undefined
    this.sendToPort(session, latest)
  }

  private waitForClose(session: Session): Promise<void> {
    if (session.closeCompleted) return Promise.resolve()
    return new Promise((resolve) => session.closeWaiters.push(resolve))
  }

  private finishClose(session: Session, processEnded: boolean): void {
    if (processEnded) {
      session.processEnded = true
      if (session.closeTimer) clearTimeout(session.closeTimer)
      session.closeTimer = undefined
    }
    if (session.closeCompleted) return
    session.closeCompleted = true
    session.latestFrame = undefined
    this.clearFrameLedger(session)
    this.clearResizeTimer(session)
    session.pendingCertificateRequests.clear()
    promptBroker.cancelForSession(session.id)
    session.port?.close()
    session.port = undefined
    this.emitState(session, 'closed', session.failureCode)
    for (const resolve of session.closeWaiters.splice(0)) resolve()
    if (session.removeWhenClosed && this.isCurrent(session)) this.sessions.delete(session.id)
  }

  private beginClose(
    session: Session,
    reason: 'user' | 'reconnect' | 'shutdown' | 'failure',
    removeWhenClosed: boolean
  ): Promise<void> {
    if (!this.isCurrent(session)) return Promise.resolve()
    session.removeWhenClosed ||= removeWhenClosed
    const completed = this.waitForClose(session)
    if (session.closeReason) {
      if (session.closeCompleted && session.removeWhenClosed) this.sessions.delete(session.id)
      return completed
    }
    session.closeReason = reason
    this.emitState(session, 'closing', session.failureCode)
    session.latestFrame = undefined
    this.clearFrameLedger(session)
    this.clearResizeTimer(session)
    session.pendingCertificateRequests.clear()
    promptBroker.cancelForSession(session.id)
    session.port?.close()
    session.port = undefined

    // A paused framebuffer pipe must be resumed so the Worker's CLOSED frame
    // can still be consumed during graceful shutdown.
    if (session.stdoutPaused) {
      session.stdoutPaused = false
      session.worker?.stdout.resume()
    }
    if (!session.worker || session.processEnded) {
      this.finishClose(session, true)
      return completed
    }
    const wireReason = reason === 'failure' ? 'shutdown' : reason
    this.write(session, 0x12, this.nextRequestId(session), { op: 'close', reason: wireReason }, true)
    if (!session.closeCompleted) {
      session.closeTimer = setTimeout(() => {
        if (!session.processEnded) {
          try { session.worker?.kill() } catch { /* process is already unavailable */ }
        }
        // After the deadline the old generation is detached even if the OS has
        // not delivered an exit event yet. Identity checks reject all late data.
        this.finishClose(session, true)
      }, CLOSE_TIMEOUT_MS)
      session.closeTimer.unref()
    }
    return completed
  }

  private fail(session: Session, requestedCode: string): void {
    if (!this.isCurrent(session) || session.closeReason) return
    const explicitCode: RdpErrorCode = ['WORKER_MISSING', 'WORKER_START_FAILED', 'PROTOCOL_MISMATCH', 'PROTOCOL_ERROR', 'WORKER_CRASHED'].includes(requestedCode)
      ? requestedCode as RdpErrorCode
      : stableWorkerError(requestedCode)
    session.failureCode = explicitCode
    this.emitState(session, 'failed', explicitCode)
    void this.beginClose(session, 'failure', false)
  }

  private validateHello(session: Session, requestId: number, payload: Buffer): string[] | null {
    const value = parseJsonObject(payload)
    if (!value || requestId !== 0 || session.helloReceived || value.op !== 'hello' || value.protocol !== VERSION) return null
    if (typeof value.workerVersion !== 'string' || value.workerVersion.length < 1 || value.workerVersion.length > 128) return null
    if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.length > KNOWN_CAPABILITIES.size) return null
    if (!value.capabilities.every((capability) => typeof capability === 'string' && KNOWN_CAPABILITIES.has(capability))) return null
    const capabilities = value.capabilities as string[]
    if (new Set(capabilities).size !== capabilities.length || ![...REQUIRED_CAPABILITIES].every((capability) => capabilities.includes(capability))) return null
    if (this.requireFreerdpWorker && (value.workerVersion !== 'freerdp' || !capabilities.includes('freerdp') || capabilities.includes('mock'))) return null
    return capabilities
  }

  private async sendPasswordIfAvailable(session: Session): Promise<void> {
    if (!this.isRunning(session)) return
    const profile = session.profile
    let password = profile.passwordRef ? vault.getSecret(profile.passwordRef) : null
    let remember = false
    if (password === null) {
      this.emitState(session, 'authenticating')
      const reply = await promptBroker.request(session.id, 'rdp-password', {
        username: profile.username,
        host: profile.host
      }, 120_000)
      if (!this.isRunning(session)) return
      if (!reply.ok || !reply.answers?.[0]) {
        this.fail(session, 'CANCELED')
        return
      }
      password = reply.answers[0]
      remember = reply.remember === true
    }
    if (!this.isRunning(session) || password === null) return
    if (remember) rememberRdpPassword(profile.id, password)
    // Keep the secret out of renderer state and clear this local as soon as
    // the Worker write is queued. Vault persistence contains only its reference.
    this.write(session, 0x11, this.nextRequestId(session), { op: 'credential', kind: 'password', value: password })
    password = ''
  }

  private handleHello(session: Session, requestId: number, payload: Buffer): void {
    const capabilities = this.validateHello(session, requestId, payload)
    if (!capabilities) return this.fail(session, 'PROTOCOL_MISMATCH')
    const profile = session.profile
    if (profile.clipboard && !capabilities.includes('clipboard')) return this.fail(session, 'UNSUPPORTED')
    session.certificatePolicy = profile.certificatePolicy
    session.helloReceived = true
    if (!this.write(session, 0x02, requestId, { op: 'helloAck', protocol: VERSION, sessionId: session.id, maxPayload: MAX_PAYLOAD })) return
    this.emitState(session, 'connecting')
    if (!this.write(session, 0x10, this.nextRequestId(session), {
      op: 'start',
      host: profile.host,
      port: profile.port,
      username: profile.username,
      domain: profile.domain,
      gateway: null,
      display: session.display,
      features: {
        clipboard: profile.clipboard,
        certificatePolicy: session.certificatePolicy
      }
    })) return
    void this.sendPasswordIfAvailable(session)
  }

  private publishReadyIfComplete(session: Session): void {
    if (!this.isRunning(session) || session.state === 'ready' || !session.workerReady || !session.firstFrameReceived) return
    this.emitState(session, 'ready')
  }

  private handleWorkerState(session: Session, payload: Buffer): void {
    const value = parseJsonObject(payload)
    // Control acknowledgements share the STATE envelope in protocol v1. They
    // have no renderer-visible state transition and are otherwise ignored.
    if (value?.op === 'ack') return
    if (!value || value.op !== 'state' || typeof value.state !== 'string' || !WORKER_STATES.has(value.state as RdpSessionState)) {
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    const state = value.state as RdpSessionState
    if (session.closeReason) {
      if (state === 'closed') {
        try { session.worker?.stdin.end() } catch { /* process may already be gone */ }
        this.finishClose(session, false)
      }
      return
    }
    if (state === 'failed') this.fail(session, stableWorkerError(value.errorCode))
    else if (state === 'closed') {
      // A remote-initiated clean close remains addressable for explicit
      // reconnect and system fallback until the renderer closes its tab.
      session.failureCode = 'NETWORK_ERROR'
      session.closeReason = 'failure'
      this.emitState(session, 'closing', session.failureCode)
      try { session.worker?.stdin.end() } catch { /* process may already be gone */ }
      session.closeTimer = setTimeout(() => {
        if (!session.processEnded) {
          try { session.worker?.kill() } catch { /* process is already unavailable */ }
        }
        this.finishClose(session, true)
      }, CLOSE_TIMEOUT_MS)
      session.closeTimer.unref()
      this.finishClose(session, false)
    } else if (state === 'closing') {
      void this.beginClose(session, 'failure', false)
    } else if (state === 'ready') {
      // Worker readiness alone is insufficient: input opens only after a
      // validated framebuffer has arrived and can seed the renderer.
      if (session.workerReady) return
      session.workerReady = true
      this.publishReadyIfComplete(session)
    } else if (state === 'connecting' || state === 'authenticating' || state === 'verifying') {
      if (session.workerReady || session.state === 'ready') return this.fail(session, 'PROTOCOL_ERROR')
      this.emitState(session, state)
    } else {
      this.fail(session, 'PROTOCOL_ERROR')
    }
  }

  private handleCertificatePrompt(session: Session, requestId: number, payload: Buffer): void {
    const value = parseJsonObject(payload)
    const prompt = value?.payload
    if (!value || value.op !== 'prompt' || value.kind !== 'certificate' || value.requestId !== requestId || requestId === 0 || !prompt || typeof prompt !== 'object' || Array.isArray(prompt)) {
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    const data = prompt as Record<string, unknown>
    if (typeof data.host !== 'string' || data.host.length < 1 || !Number.isInteger(data.port) || (data.port as number) < 1 || (data.port as number) > 65535 || typeof data.subject !== 'string' || typeof data.issuer !== 'string' || typeof data.fingerprintSha256 !== 'string' || (data.changed !== undefined && typeof data.changed !== 'boolean')) {
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    if (session.seenCertificateRequests.has(requestId)) return
    session.seenCertificateRequests.add(requestId)
    if (session.certificatePolicy === 'strict') {
      this.write(session, 0x11, requestId, { op: 'certificate', requestId, accept: false })
      return
    }
    session.pendingCertificateRequests.add(requestId)
    this.emitState(session, 'verifying')
    void promptBroker.request(session.id, 'rdp-certificate', {
      host: data.host,
      port: data.port as number,
      subject: data.subject,
      issuer: data.issuer,
      fingerprintSha256: data.fingerprintSha256,
      ...(typeof data.changed === 'boolean' ? { changed: data.changed } : {})
    }, 60_000).then((reply) => {
      const pending = session.pendingCertificateRequests.delete(requestId)
      if (!pending) return
      if (!this.isRunning(session)) return
      this.write(session, 0x11, requestId, { op: 'certificate', requestId, accept: reply.ok === true })
    }).catch(() => {
      session.pendingCertificateRequests.delete(requestId)
      this.fail(session, 'CERTIFICATE_REJECTED')
    })
  }

  private handleClipboard(session: Session, payload: Buffer): void {
    if (session.state !== 'ready' || !session.profile.clipboard) return
    const value = parseJsonObject(payload)
    if (!value || value.op !== 'clipboardData' || value.mime !== 'text/plain' || typeof value.text !== 'string' || value.text.length > 1_000_000) {
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    emit('rdp:clipboard', { sessionId: session.id, text: value.text })
  }

  private handleFrame(session: Session, payload: Buffer): void {
    const parsed = parseRdpFrameV1(payload)
    if (!parsed) this.fail(session, 'PROTOCOL_ERROR')
    else {
      session.firstFrameReceived = true
      this.queueFrame(session, parsed)
      this.publishReadyIfComplete(session)
    }
  }

  private handleProtocolFrame(session: Session, type: number, requestId: number, payload: Buffer): void {
    if (!this.isCurrent(session)) return
    if (!session.helloReceived && type !== 0x01) return this.fail(session, 'PROTOCOL_MISMATCH')
    if (session.closeReason && type !== 0x20) return
    if (type === 0x01) this.handleHello(session, requestId, payload)
    else if (type === 0x20) this.handleWorkerState(session, payload)
    else if (type === 0x21) this.handleCertificatePrompt(session, requestId, payload)
    else if (type === 0x22) this.handleClipboard(session, payload)
    else if (type === 0x30) this.handleFrame(session, payload)
    else if (type === 0x7f) {
      const value = parseJsonObject(payload)
      if (!value || value.op !== 'error') this.fail(session, 'PROTOCOL_ERROR')
      else this.fail(session, stableWorkerError(value.code))
    } else this.fail(session, 'PROTOCOL_ERROR')
  }

  private consumeFrames(session: Session): void {
    while (this.isCurrent(session) && session.inputBuffer.length >= HEADER_SIZE) {
      if (!session.inputBuffer.subarray(0, 4).equals(MAGIC) || session.inputBuffer.readUInt16LE(4) !== VERSION || session.inputBuffer[7] !== 0) {
        this.fail(session, 'PROTOCOL_ERROR')
        return
      }
      const length = session.inputBuffer.readUInt32LE(8)
      if (length > MAX_PAYLOAD) {
        this.fail(session, 'PROTOCOL_ERROR')
        return
      }
      if (session.inputBuffer.length < HEADER_SIZE + length) return
      const type = session.inputBuffer[6]
      const requestId = session.inputBuffer.readUInt32LE(12)
      const payload = session.inputBuffer.subarray(HEADER_SIZE, HEADER_SIZE + length)
      session.inputBuffer = session.inputBuffer.subarray(HEADER_SIZE + length)
      this.handleProtocolFrame(session, type, requestId, payload)
    }
  }

  private onData(session: Session, chunk: Buffer): void {
    if (!this.isCurrent(session) || session.processEnded) return
    if (session.inputBuffer.length + chunk.length > MAX_BUFFERED_BYTES) {
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    session.inputBuffer = session.inputBuffer.length === 0 ? chunk : Buffer.concat([session.inputBuffer, chunk])
    this.consumeFrames(session)
  }

  private freezeProfile(profile: ConnectionProfile | undefined): FrozenRdpProfile | null {
    if (!profile || profile.protocol !== 'rdp') return null
    const rawRdp = profile.rdp as Record<string, unknown> | undefined
    const certificatePolicy = rawRdp?.certificatePolicy ?? 'prompt'
    if (certificatePolicy !== 'prompt' && certificatePolicy !== 'strict') return null
    if (rawRdp?.clipboard !== undefined && typeof rawRdp.clipboard !== 'boolean') return null
    if (rawRdp?.domain !== undefined && typeof rawRdp.domain !== 'string') return null
    if (rawRdp?.passwordRef !== undefined && typeof rawRdp.passwordRef !== 'string') return null
    if (typeof profile.host !== 'string' || profile.host.trim().length === 0) return null
    if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) return null
    if (typeof profile.username !== 'string') return null
    return {
      id: profile.id,
      fallbackProfile: structuredClone(profile),
      host: profile.host.trim(),
      port: profile.port,
      username: profile.username,
      domain: typeof rawRdp?.domain === 'string' ? rawRdp.domain : '',
      passwordRef: typeof rawRdp?.passwordRef === 'string' ? rawRdp.passwordRef : undefined,
      clipboard: typeof rawRdp?.clipboard === 'boolean' ? rawRdp.clipboard : true,
      certificatePolicy
    }
  }

  private createSession(sessionId: SessionId, profile: FrozenRdpProfile, display: RdpDisplaySize): Session {
    const session: Session = {
      id: sessionId,
      profile,
      display: clampRdpDisplaySize(display),
      inputBuffer: Buffer.alloc(0),
      processEnded: true,
      state: 'starting',
      helloReceived: false,
      workerReady: false,
      firstFrameReceived: false,
      requestId: 1,
      pendingPortFrames: new Map(),
      stdoutPaused: false,
      lastFrameSequence: -1,
      lastResizeSentAt: -RESIZE_INTERVAL_MS,
      closeCompleted: false,
      removeWhenClosed: false,
      closeWaiters: [],
      certificatePolicy: profile.certificatePolicy,
      pendingCertificateRequests: new Set(),
      seenCertificateRequests: new Set()
    }
    return session
  }

  private startSession(sessionId: SessionId, profile: FrozenRdpProfile, display: RdpDisplaySize): void {
    const session = this.createSession(sessionId, profile, display)
    this.sessions.set(sessionId, session)
    const path = workerPath()
    if (!existsSync(path)) {
      this.fail(session, 'WORKER_MISSING')
      return
    }

    let worker: ChildProcessWithoutNullStreams
    try {
      const workerEnv = { ...process.env }
      const opensslModules = join(dirname(path), 'ossl-modules')
      if (existsSync(opensslModules)) workerEnv.OPENSSL_MODULES = opensslModules
      worker = spawn(path, [], { stdio: 'pipe', windowsHide: true, shell: false, env: workerEnv })
    } catch {
      this.fail(session, 'WORKER_START_FAILED')
      return
    }
    session.worker = worker
    session.processEnded = false
    this.emitState(session, 'starting')
    this.emitState(session, 'handshaking')
    worker.stdout.on('data', (chunk: Buffer) => this.onData(session, chunk))
    const onUnexpectedStdoutEnd = (): void => {
      if (!this.isCurrent(session) || session.processEnded) return
      // During an intentional close, stdout ending is not proof that the
      // process exited. Keep waiting for exit or the existing 2 second timer.
      if (!session.closeReason) this.fail(session, 'WORKER_CRASHED')
    }
    worker.stdout.once('end', onUnexpectedStdoutEnd)
    worker.stdout.once('close', onUnexpectedStdoutEnd)
    worker.stderr.on('data', () => {})
    worker.on('error', () => {
      // An exit/error pair can arrive in either order. Once exit has marked
      // this generation ended, its handler owns the terminal transition.
      if (session.processEnded) return
      this.fail(session, session.helloReceived ? 'WORKER_CRASHED' : 'WORKER_START_FAILED')
    })
    worker.on('exit', () => {
      session.processEnded = true
      if (!this.isCurrent(session)) return
      if (session.closeReason) this.finishClose(session, true)
      else this.fail(session, 'WORKER_CRASHED')
    })
  }

  attachPort(sessionId: SessionId, port: MessagePortMain): void {
    const session = this.sessions.get(sessionId)
    if (!session || !this.isRunning(session)) {
      port.close()
      return
    }
    if (session.port) session.port.close()
    this.clearFrameLedger(session)
    session.port = port
    port.on('message', (event: { data: unknown }) => {
      if (!this.isRunning(session) || session.port !== port) return
      const data = event.data as { kind?: unknown; sequence?: unknown }
      if (!data || typeof data !== 'object' || Object.keys(data).length !== 2 || data.kind !== 'frameAck' ||
          !Number.isInteger(data.sequence) || (data.sequence as number) < 0 || (data.sequence as number) > 0xffffffff) return
      const sequence = data.sequence as number
      const timer = session.pendingPortFrames.get(sequence)
      if (!timer) return
      clearTimeout(timer)
      session.pendingPortFrames.delete(sequence)
      this.flushLatestFrame(session)
      this.resumeStdout(session)
    })
    port.on('close', () => {
      if (!this.isRunning(session) || session.port !== port) return
      session.port = undefined
      this.clearFrameLedger(session)
      this.pauseStdout(session)
    })
    port.start()
    this.flushLatestFrame(session)
    this.resumeStdout(session)
  }

  open(profileId: string, display: RdpDisplaySize = DEFAULT_DISPLAY): { sessionId: SessionId } {
    const sessionId = randomUUID()
    const profile = this.freezeProfile(getProfile(profileId))
    if (!profile) throw new Error(t('err.rdp.profileInvalid'))
    this.startSession(sessionId, profile, clampRdpDisplaySize(display))
    return { sessionId }
  }

  private requireReady(sessionId: SessionId): Session {
    const session = this.sessions.get(sessionId)
    if (!session || !this.isRunning(session) || session.state !== 'ready') throw new Error('SESSION_NOT_READY')
    return session
  }

  input(sessionId: SessionId, input: RdpInput): void {
    const session = this.requireReady(sessionId)
    if (input.kind === 'key') {
      const { kind: _kind, ...payload } = input
      this.write(session, 0x14, this.nextRequestId(session), { op: 'key', ...payload })
      return
    }
    const { kind: _kind, ...payload } = input
    this.write(session, 0x15, this.nextRequestId(session), { op: 'pointer', ...payload })
  }

  resize(sessionId: SessionId, display: RdpDisplaySize): void {
    const session = this.requireReady(sessionId)
    const normalized = clampRdpDisplaySize(display)
    session.display = normalized
    session.pendingResize = normalized
    const elapsed = Date.now() - session.lastResizeSentAt
    if (elapsed >= RESIZE_INTERVAL_MS && !session.resizeTimer) {
      this.flushResize(session)
      return
    }
    if (!session.resizeTimer) {
      session.resizeTimer = setTimeout(() => {
        session.resizeTimer = undefined
        this.flushResize(session)
      }, Math.max(1, RESIZE_INTERVAL_MS - elapsed))
      session.resizeTimer.unref()
    }
  }

  private flushResize(session: Session): void {
    const display = session.pendingResize
    session.pendingResize = undefined
    if (!display || !this.isRunning(session) || session.state !== 'ready') return
    session.lastResizeSentAt = Date.now()
    this.write(session, 0x13, this.nextRequestId(session), { op: 'resize', ...display })
  }

  clipboardSet(sessionId: SessionId, text: string): void {
    const session = this.requireReady(sessionId)
    if (!session.profile.clipboard || text.length > 1_000_000) throw new Error('UNSUPPORTED')
    this.write(session, 0x16, this.nextRequestId(session), { op: 'clipboardSet', mime: 'text/plain', text })
  }

  clipboardGet(sessionId: SessionId): void {
    const session = this.requireReady(sessionId)
    if (!session.profile.clipboard) throw new Error('UNSUPPORTED')
    const requestId = this.nextRequestId(session)
    this.write(session, 0x17, requestId, { op: 'clipboardGet', requestId })
  }

  async close(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await this.beginClose(session, 'user', true)
  }

  async reconnect(sessionId: SessionId): Promise<void> {
    const old = this.sessions.get(sessionId)
    if (!old) throw new Error(t('err.rdp.sessionNotFound'))
    const profile = old.profile
    const display = old.display
    await this.beginClose(old, 'reconnect', false)
    if (this.sessions.get(sessionId) !== old) return
    this.emitState(old, 'reconnecting')
    this.startSession(sessionId, profile, display)
  }

  async systemFallback(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(t('err.rdp.sessionNotFound'))
    if ((session.state !== 'failed' && session.state !== 'closed') || (session.worker && !session.processEnded)) {
      throw new Error(t('err.rdp.fallbackNotAllowed'))
    }
    await launchRdp(session.profile.fallbackProfile)
  }

  /**
   * Number of RDP sessions that still own a live Worker (or are starting one).
   * Failed/closed records intentionally remain in the registry for explicit
   * reconnect and system fallback, but they no longer represent work that an
   * update would interrupt.
   */
  liveCount(): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.worker && !session.processEnded) count++
    }
    return count
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.beginClose(session, 'shutdown', true)))
  }
}

export const rdpSessionManager = new RdpSessionManager()
