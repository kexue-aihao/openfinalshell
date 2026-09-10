import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync, readdirSync, lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import electron from 'electron'
import type { MessagePortMain } from 'electron'
import {
  clampRdpDisplaySize,
  type ConnectionProfile,
  type RdpAudioState,
  type RdpClipboardProgress,
  type RdpClipboardTransferState,
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
import { scopedLogger } from '../utils/logger'

const MAGIC = Buffer.from('OFSR')
const VERSION = 1
const MAX_PAYLOAD = RDP_MAX_FRAME_BYTES
const HEADER_SIZE = 16
const MAX_BUFFERED_BYTES = MAX_PAYLOAD + HEADER_SIZE + 128 * 1024
const ACK_TIMEOUT_MS = 500
const CLOSE_TIMEOUT_MS = 2000
const RESIZE_INTERVAL_MS = 100
const MAX_IN_FLIGHT_FRAMES = 2
const HELLO_TIMEOUT_MS = 10_000
const CONNECTION_TIMEOUT_MS = 30_000
const FIRST_FRAME_TIMEOUT_MS = 15_000
const AUTH_TIMEOUT_MS = 120_000
const CERTIFICATE_TIMEOUT_MS = 60_000
const CLIPBOARD_TIMEOUT_MS = 5_000
const MAX_CLIPBOARD_FILES = 64
const MAX_CLIPBOARD_FILE_BYTES = 8 * 1024 * 1024 * 1024
const MAX_CLIPBOARD_TOTAL_BYTES = 32 * 1024 * 1024 * 1024
const DEFAULT_DISPLAY: RdpDisplaySize = { width: 1280, height: 720, dpi: 96 }
const MAX_WORKER_STDERR_BYTES = 16 * 1024
const REQUIRED_CAPABILITIES = new Set(['framebuffer', 'input', 'resize'])
const KNOWN_CAPABILITIES = new Set(['framebuffer', 'input', 'resize', 'clipboard', 'audio', 'mock', 'freerdp'])
const WORKER_AUDIO_STATES = new Set<RdpAudioState>(['disabled', 'enabled', 'connected', 'unavailable', 'stopped'])
const WORKER_ERROR_CODES = new Set([
  'AUTH_FAILED', 'ACCOUNT_LOCKED_OUT', 'CERTIFICATE_REJECTED', 'NETWORK_ERROR', 'PROTOCOL_ERROR',
  'SESSION_NOT_READY', 'UNSUPPORTED', 'WORKER_CRASHED', 'CANCELED'
])
const WORKER_STATES = new Set<RdpSessionState>([
  'connecting', 'authenticating', 'verifying', 'ready', 'failed', 'closing', 'closed'
])
const log = scopedLogger('rdp')

interface FrozenRdpProfile {
  id: string
  fallbackProfile: ConnectionProfile
  host: string
  port: number
  username: string
  domain: string
  passwordRef?: string
  clipboard: boolean
  audioPlayback: boolean
  certificatePolicy: 'prompt' | 'strict'
}

type RdpPointerInput = Extract<RdpInput, { kind: 'pointer' }>

interface Session {
  id: SessionId
  generation: number
  profile: FrozenRdpProfile
  display: RdpDisplaySize
  worker?: ChildProcessWithoutNullStreams
  workerStderr: string
  inputBuffer: RdpInputBuffer
  processEnded: boolean
  workerStdinBroken: boolean
  state: RdpSessionState
  helloReceived: boolean
  workerReady: boolean
  firstFrameReceived: boolean
  requestId: number
  port?: MessagePortMain
  pendingPortFrames: Map<number, { frame: RdpFrame; timer: NodeJS.Timeout }>
  queuedFrames: RdpFrame[]
  stdoutPaused: boolean
  lastFrameSequence: number
  lastResizeSentAt: number
  pendingResize?: RdpDisplaySize
  resizeTimer?: NodeJS.Timeout
  startupTimer?: NodeJS.Timeout
  pendingPointerMove?: RdpPointerInput
  pendingPointerTimer?: NodeJS.Immediate
  lastPointerButtons: number
  closeReason?: 'user' | 'reconnect' | 'shutdown' | 'failure'
  closeTimer?: NodeJS.Timeout
  closeCompleted: boolean
  removeWhenClosed: boolean
  closeWaiters: Array<() => void>
  failureCode?: RdpErrorCode
  /** Ask for a fresh password after the server rejects the one just tried. */
  forcePasswordPrompt: boolean
  certificatePolicy: 'prompt' | 'strict'
  audioPlayback: boolean
  pendingCertificateRequests: Set<number>
  seenCertificateRequests: Set<number>
  pendingClipboardRequests: Set<number>
  clipboardTimer?: NodeJS.Timeout
  clipboardTransferTimer?: NodeJS.Timeout
  clipboardTransfer?: { total: number; fileCount: number; active: boolean }
  pendingLocalClipboard?: { id: number; timer: NodeJS.Timeout; resolve: (paths: string[]) => void; reject: (error: Error) => void }
  pendingClipboardFileRequests: Map<number, {
    timer: NodeJS.Timeout
    resolve: () => void
    reject: (error: Error) => void
  }>
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

function redactWorkerStderr(value: string): string {
  return value
    .replace(/((?:password|passwd|pwd)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_WORKER_STDERR_BYTES)
}

function errorDescription(errorCode: RdpErrorCode): string {
  const descriptions = {
    AUTH_FAILED: t('err.rdp.authFailed'),
    ACCOUNT_LOCKED_OUT: t('err.rdp.accountLockedOut'),
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

/**
 * Keeps stdout chunks as a list until a complete protocol frame is available.
 * A child-process pipe may split one frame across many chunks; concatenating
 * the accumulated prefix for every chunk turns a large frame into O(n^2)
 * copying work.
 */
class RdpInputBuffer {
  private readonly chunks: Buffer[] = []
  private headOffset = 0
  private bufferedBytes = 0

  get length(): number {
    return this.bufferedBytes
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.bufferedBytes += chunk.length
  }

  clear(): void {
    this.chunks.length = 0
    this.headOffset = 0
    this.bufferedBytes = 0
  }

  peek(length: number): Buffer | null {
    if (length < 0 || this.bufferedBytes < length) return null
    if (length === 0) return Buffer.alloc(0)
    const first = this.chunks[0]
    if (!first) return null
    const available = first.length - this.headOffset
    if (available >= length) return first.subarray(this.headOffset, this.headOffset + length)
    const out = Buffer.allocUnsafe(length)
    let copied = 0
    for (let index = 0; index < this.chunks.length && copied < length; index++) {
      const chunk = this.chunks[index]
      const offset = index === 0 ? this.headOffset : 0
      const take = Math.min(chunk.length - offset, length - copied)
      chunk.copy(out, copied, offset, offset + take)
      copied += take
    }
    return out
  }

  consume(length: number): Buffer {
    const out = this.peek(length)
    if (!out) throw new Error('RDP input buffer underflow')
    let remaining = length
    while (remaining > 0) {
      const first = this.chunks[0]
      if (!first) throw new Error('RDP input buffer underflow')
      const available = first.length - this.headOffset
      if (available <= remaining) {
        this.chunks.shift()
        this.headOffset = 0
        remaining -= available
      } else {
        this.headOffset += remaining
        remaining = 0
      }
    }
    this.bufferedBytes -= length
    return out
  }
}

export class RdpSessionManager {
  private readonly sessions = new Map<SessionId, Session>()
  private readonly requireFreerdpWorker: boolean
  private nextGeneration = 1

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

  private emitAudio(session: Session, state: RdpAudioState, errorCode?: string): void {
    if (!this.isCurrent(session)) return
    emit('rdp:audio', {
      sessionId: session.id,
      state,
      ...(errorCode ? { errorCode } : {})
    })
  }

  private write(session: Session, type: number, requestId: number, payload: Record<string, unknown>, allowClosing = false): boolean {
    const stdin = session.worker?.stdin
    if (!this.isCurrent(session) || !session.worker || session.processEnded || session.workerStdinBroken ||
        (!allowClosing && session.closeReason) || !stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) return false
    try {
      stdin.write(jsonFrame(type, requestId, payload), (error?: Error | null) => {
        if (!error || session.workerStdinBroken) return
        session.workerStdinBroken = true
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED') {
          log.warn(`RDP session ${session.id}: worker stdin write failed: ${error.message}`)
        }
        if (this.isCurrent(session) && !session.processEnded && !session.closeReason) {
          this.fail(session, 'WORKER_CRASHED')
        }
      })
      return true
    } catch {
      session.workerStdinBroken = true
      if (session.closeReason) this.finishClose(session, true)
      else this.fail(session, 'WORKER_CRASHED')
      return false
    }
  }

  private clearFrameLedger(session: Session, preserveFrames = false): void {
    const inFlight = preserveFrames
      ? [...session.pendingPortFrames.values()].map(({ frame }) => frame)
      : []
    for (const { timer } of session.pendingPortFrames.values()) clearTimeout(timer)
    session.pendingPortFrames.clear()
    if (inFlight.length > 0) {
      session.queuedFrames = [...inFlight, ...session.queuedFrames]
      this.sortQueuedFrames(session)
    }
  }

  private sortQueuedFrames(session: Session): void {
    // Retries can reinsert an older sequence after a newer frame was sent.
    // Reconnecting the MessagePort must restore logical RDP order, not Map
    // insertion order.
    session.queuedFrames.sort((left, right) => left.sequence - right.sequence)
  }

  private clearResizeTimer(session: Session): void {
    if (session.resizeTimer) clearTimeout(session.resizeTimer)
    session.resizeTimer = undefined
    session.pendingResize = undefined
  }

  private clearStartupTimer(session: Session): void {
    if (session.startupTimer) clearTimeout(session.startupTimer)
    session.startupTimer = undefined
  }

  private armStartupTimer(session: Session, timeoutMs: number, errorCode: RdpErrorCode): void {
    this.clearStartupTimer(session)
    if (!this.isRunning(session)) return
    session.startupTimer = setTimeout(() => {
      session.startupTimer = undefined
      if (!this.isRunning(session)) return
      log.warn(`RDP session ${session.id}: startup watchdog expired (${errorCode})`)
      this.fail(session, errorCode)
    }, timeoutMs)
    session.startupTimer.unref()
  }

  private clearPendingPointerMove(session: Session): void {
    if (session.pendingPointerTimer) clearImmediate(session.pendingPointerTimer)
    session.pendingPointerTimer = undefined
    session.pendingPointerMove = undefined
  }

  private clearClipboardRequests(session: Session): void {
    if (session.clipboardTimer) clearTimeout(session.clipboardTimer)
    session.clipboardTimer = undefined
    session.pendingClipboardRequests.clear()
  }

  private clearClipboardFileRequests(session: Session, errorCode = 'CANCELED'): void {
    if (session.pendingLocalClipboard) {
      clearTimeout(session.pendingLocalClipboard.timer)
      session.pendingLocalClipboard.reject(new Error('CANCELED'))
      session.pendingLocalClipboard = undefined
    }
    for (const pending of session.pendingClipboardFileRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(errorCode))
    }
    session.pendingClipboardFileRequests.clear()
  }

  private emitClipboardProgress(
    session: Session,
    state: RdpClipboardTransferState,
    details: Partial<Omit<RdpClipboardProgress, 'sessionId' | 'state'>> = {}
  ): void {
    if (!this.isCurrent(session)) return
    emit('rdp:clipboardProgress', {
      sessionId: session.id,
      state,
      fileIndex: details.fileIndex ?? 0,
      fileCount: details.fileCount ?? session.clipboardTransfer?.fileCount ?? 0,
      ...(details.fileName ? { fileName: details.fileName } : {}),
      transferred: details.transferred ?? 0,
      total: details.total ?? session.clipboardTransfer?.total ?? 0,
      speedBps: details.speedBps ?? 0,
      ...(details.error ? { error: details.error } : {})
    })
  }

  private clearClipboardTransfer(session: Session, state: 'canceled' | 'completed' = 'canceled'): void {
    clearTimeout(session.clipboardTransferTimer)
    const transfer = session.clipboardTransfer
    if (!transfer) return
    if (transfer.active) this.emitClipboardProgress(session, state, {
      fileCount: transfer.fileCount,
      total: transfer.total
    })
    session.clipboardTransfer = undefined
  }

  private armClipboardTransferTimeout(session: Session): void {
    clearTimeout(session.clipboardTransferTimer)
    session.clipboardTransferTimer = setTimeout(() => {
      this.failClipboardTransfer(session, 'CLIPBOARD_TIMEOUT')
    }, 30_000)
    session.clipboardTransferTimer.unref()
  }

  private failClipboardTransfer(session: Session, error: string): void {
    clearTimeout(session.clipboardTransferTimer)
    const transfer = session.clipboardTransfer
    if (!transfer || !transfer.active) return
    transfer.active = false
    this.emitClipboardProgress(session, 'failed', {
      fileCount: transfer.fileCount,
      total: transfer.total,
      error
    })
  }

  private flushPendingPointerMove(session: Session): void {
    if (!session.pendingPointerMove) return
    const input = session.pendingPointerMove
    session.pendingPointerMove = undefined
    if (this.isRunning(session) && session.state === 'ready') {
      const { kind: _kind, ...payload } = input
      this.write(session, 0x15, this.nextRequestId(session), { op: 'pointer', ...payload })
    }
  }

  private queuePointerMove(session: Session, input: RdpPointerInput): void {
    session.pendingPointerMove = input
    if (session.pendingPointerTimer) return
    session.pendingPointerTimer = setImmediate(() => {
      session.pendingPointerTimer = undefined
      this.flushPendingPointerMove(session)
    })
    session.pendingPointerTimer.unref()
  }

  private pauseStdout(session: Session): void {
    if (session.stdoutPaused || !this.isRunning(session) || !session.worker) return
    session.stdoutPaused = true
    session.worker.stdout.pause()
  }

  private resumeStdout(session: Session): void {
    if (!session.stdoutPaused || !this.isRunning(session) || !session.worker || !session.port ||
        session.queuedFrames.length > 0 || session.pendingPortFrames.size >= MAX_IN_FLIGHT_FRAMES) return
    session.stdoutPaused = false
    session.worker.stdout.resume()
    this.consumeFrames(session)
  }

  private expireFrame(session: Session, sequence: number): void {
    if (!this.isRunning(session)) return
    const pending = session.pendingPortFrames.get(sequence)
    if (!pending) return
    // A framebuffer frame is a dirty-rectangle delta, so timing it out must
    // not discard it. Requeue the same delta and let the normal pump retry it;
    // dropping it would permanently leave stale pixels in the canvas.
    session.pendingPortFrames.delete(sequence)
    session.queuedFrames.unshift(pending.frame)
    this.sortQueuedFrames(session)
    this.pumpFrames(session)
  }

  private sendToPort(session: Session, parsed: RdpFrame): boolean {
    const port = session.port
    if (!port || !this.isRunning(session)) return false
    // parseRdpFrameV1 already returns an owned, exact-sized Uint8Array. Reuse
    // that ArrayBuffer for the MessagePort structured clone; keep a fallback
    // for frames constructed by tests or future callers with a subview.
    const buffer = parsed.data.byteOffset === 0 && parsed.data.byteLength === parsed.data.buffer.byteLength
      ? parsed.data.buffer
      : parsed.data.slice().buffer
    const timer = setTimeout(() => this.expireFrame(session, parsed.sequence), ACK_TIMEOUT_MS)
    timer.unref()
    session.pendingPortFrames.set(parsed.sequence, { frame: parsed, timer })
    try {
      // Electron's MessagePortMain transfer list accepts MessagePortMain
      // instances, not ArrayBuffer values. Passing the framebuffer there throws
      // at runtime ("Port at index 0 is not a valid port") and leaves the
      // session ready with a permanently paused stdout. Structured cloning the
      // ArrayBuffer is intentional here; parseRdpFrameV1 owns this buffer and
      // the fallback above isolates subviews before the post.
      port.postMessage({
        kind: 'frame',
        sequence: parsed.sequence,
        canvasWidth: parsed.canvasWidth,
        canvasHeight: parsed.canvasHeight,
        buffer
      })
    } catch (error) {
      log.warn(`RDP session ${session.id}: framebuffer delivery failed: ${error instanceof Error ? error.message : String(error)}`)
      clearTimeout(timer)
      session.pendingPortFrames.delete(parsed.sequence)
      this.pauseStdout(session)
      return false
    }
    return true
  }

  private queueFrame(session: Session, parsed: RdpFrame): void {
    if (!this.isRunning(session)) return
    if (parsed.sequence <= session.lastFrameSequence) return
    session.lastFrameSequence = parsed.sequence
    if (!session.port || session.pendingPortFrames.size >= MAX_IN_FLIGHT_FRAMES) {
      // RDP FRAME payloads contain dirty rectangles, not complete framebuffer
      // snapshots. Every frame must remain in order; dropping an intermediate
      // frame leaves stale or black regions in the composed desktop.
      session.queuedFrames.push(parsed)
      this.pauseStdout(session)
      return
    }
    if (!this.sendToPort(session, parsed)) {
      session.queuedFrames.push(parsed)
      this.pauseStdout(session)
      return
    }
    if (session.pendingPortFrames.size >= MAX_IN_FLIGHT_FRAMES) this.pauseStdout(session)
  }

  private pumpFrames(session: Session): void {
    if (!this.isRunning(session) || !session.port) return
    while (session.pendingPortFrames.size < MAX_IN_FLIGHT_FRAMES && session.queuedFrames.length > 0) {
      const next = session.queuedFrames.shift()!
      if (!this.sendToPort(session, next)) {
        session.queuedFrames.unshift(next)
        break
      }
    }
    if (session.pendingPortFrames.size >= MAX_IN_FLIGHT_FRAMES || session.queuedFrames.length > 0) {
      this.pauseStdout(session)
    } else {
      this.resumeStdout(session)
    }
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
    session.queuedFrames = []
    session.inputBuffer.clear()
    this.clearFrameLedger(session)
    this.clearResizeTimer(session)
    this.clearStartupTimer(session)
    this.clearPendingPointerMove(session)
    session.pendingCertificateRequests.clear()
    this.clearClipboardTransfer(session)
    this.clearClipboardFileRequests(session)
    this.clearClipboardRequests(session)
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
    session.queuedFrames = []
    this.clearFrameLedger(session)
    this.clearResizeTimer(session)
    this.clearStartupTimer(session)
    this.clearPendingPointerMove(session)
    session.pendingCertificateRequests.clear()
    this.clearClipboardTransfer(session)
    this.clearClipboardFileRequests(session)
    this.clearClipboardRequests(session)
    promptBroker.cancelForSession(session.id)
    session.port?.close()
    session.port = undefined

    // A paused framebuffer pipe must be resumed so the Worker's CLOSED frame
    // can still be consumed during graceful shutdown.
    if (session.stdoutPaused) {
      session.stdoutPaused = false
      session.worker?.stdout.resume()
    }
    if (!session.worker || session.processEnded || session.workerStdinBroken) {
      if (session.workerStdinBroken && !session.processEnded) {
        try { session.worker?.kill() } catch { /* process is already unavailable */ }
      }
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

  /** Non-secret identity used in failure diagnostics. Never include the password. */
  private describeIdentity(session: Session): string {
    const { host, port, username, domain } = session.profile
    return `${domain ? `${domain}\\` : ''}${username} at ${host}:${port}`
  }

  private fail(session: Session, requestedCode: string): void {
    if (!this.isCurrent(session) || session.closeReason) return
    const explicitCode: RdpErrorCode = ['WORKER_MISSING', 'WORKER_START_FAILED', 'PROTOCOL_MISMATCH', 'PROTOCOL_ERROR', 'WORKER_CRASHED'].includes(requestedCode)
      ? requestedCode as RdpErrorCode
      : stableWorkerError(requestedCode)
    session.failureCode = explicitCode
    log.warn(`RDP session ${session.id}: failure ${explicitCode} (requested=${requestedCode}, generation=${session.generation})`)
    // A rejected password must never be retried silently. A locked account,
    // however, is not a wrong password: prompting for a fresh one cannot help,
    // and repeated attempts can extend the server-side lockout window.
    if (explicitCode === 'AUTH_FAILED') {
      session.forcePasswordPrompt = true
      log.warn(`RDP session ${session.id}: authentication failed for ${this.describeIdentity(session)}; the next attempt will ask for fresh credentials`)
    } else if (explicitCode === 'ACCOUNT_LOCKED_OUT') {
      session.forcePasswordPrompt = false
      log.warn(`RDP session ${session.id}: server rejected authentication with account status 0x20018 for ${this.describeIdentity(session)}; verify server events; no forced password prompt`)
    }
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
    let password = session.forcePasswordPrompt
      ? null
      : profile.passwordRef ? vault.getSecret(profile.passwordRef) : null
    const prompted = password === null
    let remember = false
    if (prompted) {
      this.emitState(session, 'authenticating')
      this.armStartupTimer(session, AUTH_TIMEOUT_MS, 'NETWORK_ERROR')
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
    const rememberedPasswordRef = remember ? rememberRdpPassword(profile.id, password) : undefined
    if (prompted) {
      session.forcePasswordPrompt = rememberedPasswordRef === undefined
      if (remember) session.profile.passwordRef = rememberedPasswordRef
    }
    // Keep the secret out of renderer state and clear this local as soon as
    // the Worker write is queued. Vault persistence contains only its reference.
    if (!this.write(session, 0x11, this.nextRequestId(session), { op: 'credential', kind: 'password', value: password })) return
    if (session.workerReady) {
      if (session.firstFrameReceived) this.clearStartupTimer(session)
      else this.armStartupTimer(session, FIRST_FRAME_TIMEOUT_MS, 'NETWORK_ERROR')
    } else {
      this.armStartupTimer(session, CONNECTION_TIMEOUT_MS, 'NETWORK_ERROR')
    }
    password = ''
  }

  private handleHello(session: Session, requestId: number, payload: Buffer): void {
    const capabilities = this.validateHello(session, requestId, payload)
    if (!capabilities) return this.fail(session, 'PROTOCOL_MISMATCH')
    const profile = session.profile
    if (profile.clipboard && !capabilities.includes('clipboard')) return this.fail(session, 'UNSUPPORTED')
    const audioSupported = capabilities.includes('audio')
    if (profile.audioPlayback && !audioSupported) this.emitAudio(session, 'unavailable', 'AUDIO_UNSUPPORTED')
    session.certificatePolicy = profile.certificatePolicy
    session.helloReceived = true
    if (!this.write(session, 0x02, requestId, { op: 'helloAck', protocol: VERSION, sessionId: session.id, maxPayload: MAX_PAYLOAD })) return
    this.emitState(session, 'connecting')
    this.armStartupTimer(session, CONNECTION_TIMEOUT_MS, 'NETWORK_ERROR')
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
        certificatePolicy: session.certificatePolicy,
        ...(audioSupported ? { audioPlayback: profile.audioPlayback } : {})
      }
    })) return
    void this.sendPasswordIfAvailable(session)
  }

  private publishReadyIfComplete(session: Session): void {
    if (!this.isRunning(session) || session.state === 'ready' || !session.workerReady || !session.firstFrameReceived) return
    this.emitState(session, 'ready')
  }

  private handleWorkerState(session: Session, requestId: number, payload: Buffer): void {
    const value = parseJsonObject(payload)
    // Control acknowledgements share the STATE envelope in protocol v1. They
    // have no renderer-visible state transition and are otherwise ignored.
    if (value?.op === 'ack') {
      const pending = session.pendingClipboardFileRequests.get(requestId)
      if (pending) {
        clearTimeout(pending.timer)
        session.pendingClipboardFileRequests.delete(requestId)
        pending.resolve()
      }
      return
    }
    if (!value || value.op !== 'state' || typeof value.state !== 'string' || !WORKER_STATES.has(value.state as RdpSessionState)) {
      log.warn(`RDP session ${session.id}: invalid Worker state payload`)
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    const state = value.state as RdpSessionState
    if (state === 'failed') {
      log.warn(`RDP session ${session.id}: Worker reported failed state (${String(value.errorCode ?? 'none')})`)
    } else {
      log.info(`RDP session ${session.id}: Worker state ${state}`)
    }
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
      if (session.firstFrameReceived) this.clearStartupTimer(session)
      else this.armStartupTimer(session, FIRST_FRAME_TIMEOUT_MS, 'NETWORK_ERROR')
    } else if (state === 'connecting' || state === 'authenticating' || state === 'verifying') {
      if (session.workerReady || session.state === 'ready') return this.fail(session, 'PROTOCOL_ERROR')
      this.emitState(session, state)
    } else {
      this.fail(session, 'PROTOCOL_ERROR')
    }
  }

  private handleAudio(session: Session, payload: Buffer): void {
    const value = parseJsonObject(payload)
    if (!value || value.op !== 'audio' || typeof value.state !== 'string' ||
        !WORKER_AUDIO_STATES.has(value.state as RdpAudioState) ||
        (value.errorCode !== undefined && typeof value.errorCode !== 'string')) {
      log.warn(`RDP session ${session.id}: invalid Worker audio payload`)
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    this.emitAudio(session, value.state as RdpAudioState,
                   typeof value.errorCode === 'string' ? value.errorCode : undefined)
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
    this.armStartupTimer(session, CERTIFICATE_TIMEOUT_MS, 'CERTIFICATE_REJECTED')
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
      if (this.write(session, 0x11, requestId, { op: 'certificate', requestId, accept: reply.ok === true })) {
        if (session.workerReady) {
          if (session.firstFrameReceived) this.clearStartupTimer(session)
          else this.armStartupTimer(session, FIRST_FRAME_TIMEOUT_MS, 'NETWORK_ERROR')
        } else {
          this.armStartupTimer(session, CONNECTION_TIMEOUT_MS, 'NETWORK_ERROR')
        }
      }
    }).catch(() => {
      session.pendingCertificateRequests.delete(requestId)
      this.fail(session, 'CERTIFICATE_REJECTED')
    })
  }

  private handleClipboard(session: Session, requestId: number, payload: Buffer): void {
    if (session.state !== 'ready' || !session.profile.clipboard) return
    if (requestId === 0 || !session.pendingClipboardRequests.delete(requestId)) {
      log.warn(`RDP session ${session.id}: unsolicited clipboard response ${requestId}`)
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    if (session.clipboardTimer) clearTimeout(session.clipboardTimer)
    session.clipboardTimer = undefined
    const value = parseJsonObject(payload)
    // The native OLE object already owns this selection; a text write would destroy it.
    if (value?.op === 'clipboardData' && value.mime === 'application/x-ofs-rdp-files') return
    if (!value || value.op !== 'clipboardData' || value.mime !== 'text/plain' || typeof value.text !== 'string' || value.text.length > 1_000_000) {
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    emit('rdp:clipboard', { sessionId: session.id, text: value.text })
  }

  private handleClipboardProgress(session: Session, payload: Buffer): void {
    if (!session.profile.clipboard) return
    const value = parseJsonObject(payload)
    const states = new Set(['preparing', 'transferring', 'completed', 'failed', 'canceled'])
    const isSafeInteger = (input: unknown): input is number =>
      typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
    const isSafeNumber = (input: unknown): input is number =>
      typeof input === 'number' && Number.isFinite(input) && input >= 0
    const transfer = session.clipboardTransfer
    if (!value || value.op !== 'clipboardProgress' || typeof value.state !== 'string' ||
        !states.has(value.state) || !isSafeInteger(value.fileIndex) || !isSafeInteger(value.fileCount) ||
        value.fileCount < 1 || value.fileCount > MAX_CLIPBOARD_FILES || value.fileIndex > value.fileCount ||
        !isSafeInteger(value.transferred) || !isSafeInteger(value.total) ||
        !isSafeNumber(value.speedBps) || value.transferred > value.total ||
        !transfer || value.fileCount !== transfer.fileCount || value.total !== transfer.total ||
        (value.fileName !== undefined && (typeof value.fileName !== 'string' || value.fileName.length > 2048)) ||
        (value.error !== undefined && typeof value.error !== 'string')) {
      log.warn(`RDP session ${session.id}: invalid clipboard progress payload`)
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    if (!transfer.active) return
    this.armClipboardTransferTimeout(session)
    const state = value.state as RdpClipboardTransferState
    emit('rdp:clipboardProgress', {
      sessionId: session.id,
      state,
      fileIndex: value.fileIndex,
      fileCount: value.fileCount,
      ...(typeof value.fileName === 'string' ? { fileName: value.fileName } : {}),
      transferred: value.transferred,
      total: value.total,
      speedBps: value.speedBps,
      ...(typeof value.error === 'string' ? { error: value.error } : {})
    })
    if (state === 'completed' || state === 'failed' || state === 'canceled') {
      clearTimeout(session.clipboardTransferTimer)
      if (session.clipboardTransfer) session.clipboardTransfer.active = false
    }
  }

  /** 远端文件剪贴板清单（FileGroupDescriptorW 已解析）。渲染层据此提供"下载到目录"。 */
  private handleRemoteFiles(session: Session, payload: Buffer): void {
    const value = parseJsonObject(payload)
    const validFile = (item: unknown): boolean => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      const record = item as Record<string, unknown>
      return typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 2048 &&
        Number.isSafeInteger(record.size) && (record.size as number) >= 0 &&
        typeof record.directory === 'boolean'
    }
    if (!value || value.op !== 'remoteFiles' || !Array.isArray(value.files) ||
        value.files.length > MAX_CLIPBOARD_FILES || !value.files.every(validFile)) {
      log.warn(`RDP session ${session.id}: invalid remote files payload`)
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    emit('rdp:clipboardRemoteFiles', {
      sessionId: session.id,
      files: (value.files as Array<Record<string, unknown>>).map((f) => ({
        name: f.name as string,
        size: f.size as number,
        directory: f.directory as boolean
      }))
    })
  }

  /** 显式"远端文件下载到目录"命令的终态（0x27）。 */
  private handleDownloadResult(session: Session, payload: Buffer): void {
    const value = parseJsonObject(payload)
    if (!value || value.op !== 'downloadResult' || (value.state !== 'completed' && value.state !== 'failed') ||
        !Number.isSafeInteger(value.fileCount) || (value.fileCount as number) < 0 ||
        (value.error !== undefined && typeof value.error !== 'string')) {
      log.warn(`RDP session ${session.id}: invalid download result payload`)
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    emit('rdp:clipboardDownloadResult', {
      sessionId: session.id,
      state: value.state as 'completed' | 'failed',
      fileCount: value.fileCount as number,
      ...(typeof value.error === 'string' ? { error: value.error } : {})
    })
  }

  private handleFrame(session: Session, payload: Buffer): void {
    const parsed = parseRdpFrameV1(payload)
    if (!parsed) {
      log.warn(`RDP session ${session.id}: rejected framebuffer payload (${payload.byteLength} bytes)`)
      this.fail(session, 'PROTOCOL_ERROR')
    }
    else {
      session.firstFrameReceived = true
      this.queueFrame(session, parsed)
      this.publishReadyIfComplete(session)
      if (session.workerReady) this.clearStartupTimer(session)
    }
  }

  private handleProtocolFrame(session: Session, type: number, requestId: number, payload: Buffer): void {
    if (!this.isCurrent(session)) return
    if (!session.helloReceived && type !== 0x01) return this.fail(session, 'PROTOCOL_MISMATCH')
    if (session.closeReason && type !== 0x20) return
    if (type === 0x01) this.handleHello(session, requestId, payload)
    else if (type === 0x20) this.handleWorkerState(session, requestId, payload)
    else if (type === 0x21) this.handleCertificatePrompt(session, requestId, payload)
    else if (type === 0x22) this.handleClipboard(session, requestId, payload)
    else if (type === 0x25) {
      const pending = session.pendingLocalClipboard
      if (!pending || pending.id !== requestId) return
      clearTimeout(pending.timer)
      session.pendingLocalClipboard = undefined
      const value = parseJsonObject(payload)
      if (value?.op !== 'clipboardLocalFiles' || !Array.isArray(value.files) || value.files.length > 64 ||
          !value.files.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 32_768)) {
        pending.reject(new Error('PROTOCOL_ERROR'))
      } else pending.resolve(value.files as string[])
    }
    else if (type === 0x24) this.handleClipboardProgress(session, payload)
    else if (type === 0x26) this.handleRemoteFiles(session, payload)
    else if (type === 0x27) this.handleDownloadResult(session, payload)
    else if (type === 0x23) this.handleAudio(session, payload)
    else if (type === 0x30) this.handleFrame(session, payload)
    else if (type === 0x7f) {
      const value = parseJsonObject(payload)
      if (!value || value.op !== 'error') {
        log.warn(`RDP session ${session.id}: invalid Worker error payload`)
        this.fail(session, 'PROTOCOL_ERROR')
      } else {
        const pending = session.pendingClipboardFileRequests.get(requestId)
        if (pending) {
          clearTimeout(pending.timer)
          session.pendingClipboardFileRequests.delete(requestId)
          const error = typeof value.code === 'string' ? value.code : 'FILE_TRANSFER_FAILED'
          this.failClipboardTransfer(session, error)
          pending.reject(new Error(error))
          return
        }
        log.warn(`RDP session ${session.id}: Worker error ${String(value.code ?? 'unknown')}: ${String(value.message ?? '')}`)
        this.fail(session, stableWorkerError(value.code))
      }
    } else {
      log.warn(`RDP session ${session.id}: unknown Worker message type 0x${type.toString(16)}`)
      this.fail(session, 'PROTOCOL_ERROR')
    }
  }

  private consumeFrames(session: Session): void {
    while (this.isCurrent(session) && !session.stdoutPaused && session.inputBuffer.length >= HEADER_SIZE) {
      const header = session.inputBuffer.peek(HEADER_SIZE)
      if (!header || !header.subarray(0, 4).equals(MAGIC) || header.readUInt16LE(4) !== VERSION || header[7] !== 0) {
        log.warn(`RDP session ${session.id}: invalid Worker frame header`)
        this.fail(session, 'PROTOCOL_ERROR')
        return
      }
      const length = header.readUInt32LE(8)
      if (length > MAX_PAYLOAD) {
        log.warn(`RDP session ${session.id}: Worker payload exceeds limit (${length} bytes)`)
        this.fail(session, 'PROTOCOL_ERROR')
        return
      }
      if (session.inputBuffer.length < HEADER_SIZE + length) return
      const type = header[6]
      const requestId = header.readUInt32LE(12)
      session.inputBuffer.consume(HEADER_SIZE)
      const payload = session.inputBuffer.consume(length)
      this.handleProtocolFrame(session, type, requestId, payload)
    }
  }

  private onData(session: Session, chunk: Buffer): void {
    if (!this.isCurrent(session) || session.processEnded) return
    if (session.inputBuffer.length + chunk.length > MAX_BUFFERED_BYTES) {
      this.fail(session, 'PROTOCOL_ERROR')
      return
    }
    session.inputBuffer.append(chunk)
    this.consumeFrames(session)
  }

  private freezeProfile(profile: ConnectionProfile | undefined): FrozenRdpProfile | null {
    if (!profile || profile.protocol !== 'rdp') return null
    const rawRdp = profile.rdp as Record<string, unknown> | undefined
    const certificatePolicy = rawRdp?.certificatePolicy ?? 'prompt'
    if (certificatePolicy !== 'prompt' && certificatePolicy !== 'strict') return null
    if (rawRdp?.clipboard !== undefined && typeof rawRdp.clipboard !== 'boolean') return null
    if (rawRdp?.audioPlayback !== undefined && typeof rawRdp.audioPlayback !== 'boolean') return null
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
      username: profile.username.trim(),
      domain: typeof rawRdp?.domain === 'string' ? rawRdp.domain.trim() : '',
      passwordRef: typeof rawRdp?.passwordRef === 'string' ? rawRdp.passwordRef : undefined,
      clipboard: typeof rawRdp?.clipboard === 'boolean' ? rawRdp.clipboard : true,
      audioPlayback: typeof rawRdp?.audioPlayback === 'boolean' ? rawRdp.audioPlayback : true,
      certificatePolicy
    }
  }

  private createSession(
    sessionId: SessionId,
    profile: FrozenRdpProfile,
    display: RdpDisplaySize,
    forcePasswordPrompt = false
  ): Session {
    const session: Session = {
      id: sessionId,
      generation: this.nextGeneration++,
      profile,
      display: clampRdpDisplaySize(display),
      inputBuffer: new RdpInputBuffer(),
      pendingClipboardRequests: new Set(),
      pendingClipboardFileRequests: new Map(),
      processEnded: true,
      workerStdinBroken: false,
      state: 'starting',
      helloReceived: false,
      workerReady: false,
      firstFrameReceived: false,
      workerStderr: '',
      requestId: 1,
      pendingPortFrames: new Map(),
      queuedFrames: [],
      stdoutPaused: false,
      lastFrameSequence: -1,
      lastResizeSentAt: -RESIZE_INTERVAL_MS,
      lastPointerButtons: 0,
      closeCompleted: false,
      removeWhenClosed: false,
      closeWaiters: [],
      forcePasswordPrompt,
      certificatePolicy: profile.certificatePolicy,
      audioPlayback: profile.audioPlayback,
      pendingCertificateRequests: new Set(),
      seenCertificateRequests: new Set()
    }
    return session
  }

  private startSession(
    sessionId: SessionId,
    profile: FrozenRdpProfile,
    display: RdpDisplaySize,
    forcePasswordPrompt = false
  ): void {
    const session = this.createSession(sessionId, profile, display, forcePasswordPrompt)
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
    const generation = session.generation
    session.workerStdinBroken = false
    // Child stdin can close before our shutdown path runs. Always consume the
    // stream error so an EPIPE cannot become an uncaughtException.
    const stdinErrorListener = (error: NodeJS.ErrnoException): void => {
      if (session.generation !== generation || session.processEnded) return
      session.workerStdinBroken = true
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        log.warn(`RDP session ${session.id}: worker stdin error ${error.code ?? error.message}`)
      }
      if (session.closeReason) {
        try { worker.kill() } catch { /* process is already unavailable */ }
        this.finishClose(session, true)
      } else this.fail(session, 'WORKER_CRASHED')
    }
    if (typeof (worker.stdin as unknown as { on?: unknown }).on === 'function') {
      worker.stdin.on('error', stdinErrorListener)
    }
    session.processEnded = false
    this.armStartupTimer(session, HELLO_TIMEOUT_MS, 'WORKER_CRASHED')
    this.emitState(session, 'starting')
    this.emitState(session, 'handshaking')
    worker.stdout.on('data', (chunk: Buffer) => {
      if (session.generation === generation) this.onData(session, chunk)
    })
    const onUnexpectedStdoutEnd = (): void => {
      if (session.generation !== generation || !this.isCurrent(session) || session.processEnded) return
      // During an intentional close, stdout ending is not proof that the
      // process exited. Keep waiting for exit or the existing 2 second timer.
      if (!session.closeReason) this.fail(session, 'WORKER_CRASHED')
    }
    worker.stdout.once('end', onUnexpectedStdoutEnd)
    worker.stdout.once('close', onUnexpectedStdoutEnd)
    worker.stderr.on('data', (chunk: Buffer) => {
      if (session.generation !== generation || session.workerStderr.length >= MAX_WORKER_STDERR_BYTES) return
      session.workerStderr += chunk.toString('utf8').slice(0, MAX_WORKER_STDERR_BYTES - session.workerStderr.length)
    })
    worker.on('error', () => {
      // An exit/error pair can arrive in either order. Once exit has marked
      // this generation ended, its handler owns the terminal transition.
      if (session.generation !== generation || session.processEnded) return
      this.fail(session, session.helloReceived ? 'WORKER_CRASHED' : 'WORKER_START_FAILED')
    })
    worker.on('exit', (code, signal) => {
      session.processEnded = true
      const stderr = redactWorkerStderr(session.workerStderr)
      log.info(`RDP session ${session.id}: Worker exited code=${code ?? 'null'} signal=${signal ?? 'none'} generation=${generation}`)
      if (stderr) log.warn(`RDP session ${session.id}: Worker stderr: ${stderr}`)
      if (session.generation !== generation || !this.isCurrent(session)) return
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
    this.clearFrameLedger(session, true)
    session.port = port
    port.on('message', (event: { data: unknown }) => {
      if (!this.isRunning(session) || session.port !== port) return
      const data = event.data as { kind?: unknown; sequence?: unknown }
      if (!data || typeof data !== 'object' || Object.keys(data).length !== 2 || data.kind !== 'frameAck' ||
          !Number.isInteger(data.sequence) || (data.sequence as number) < 0 || (data.sequence as number) > 0xffffffff) return
      const sequence = data.sequence as number
      const pending = session.pendingPortFrames.get(sequence)
      if (!pending) return
      clearTimeout(pending.timer)
      session.pendingPortFrames.delete(sequence)
      this.pumpFrames(session)
    })
    port.on('close', () => {
      if (!this.isRunning(session) || session.port !== port) return
      session.port = undefined
      this.clearFrameLedger(session, true)
      this.pauseStdout(session)
    })
    port.start()
    this.pumpFrames(session)
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
      this.flushPendingPointerMove(session)
      const { kind: _kind, ...payload } = input
      // Key/mouse input is fire-and-forget. A zero request id tells the worker
      // not to send an ACK back through the framebuffer stdout pipe.
      this.write(session, 0x14, 0, { op: 'key', ...payload })
      return
    }
    const previousButtons = session.lastPointerButtons
    session.lastPointerButtons = input.buttons & 0x7
    const hasWheel = (input.wheelX ?? 0) !== 0 || (input.wheelY ?? 0) !== 0
    if (!hasWheel && previousButtons === session.lastPointerButtons) {
      this.queuePointerMove(session, input)
      return
    }
    this.flushPendingPointerMove(session)
    const { kind: _kind, ...payload } = input
    this.write(session, 0x15, 0, { op: 'pointer', ...payload })
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

  clipboardLocalFiles(sessionId: SessionId): Promise<string[]> {
    const session = this.requireReady(sessionId)
    if (!session.profile.clipboard || session.pendingLocalClipboard) return Promise.reject(new Error('UNSUPPORTED'))
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId(session)
      const timer = setTimeout(() => {
        session.pendingLocalClipboard = undefined
        reject(new Error('CLIPBOARD_TIMEOUT'))
      }, CLIPBOARD_TIMEOUT_MS)
      timer.unref()
      session.pendingLocalClipboard = { id, timer, resolve, reject }
      if (!this.write(session, 0x19, id, { op: 'clipboardLocalFiles' })) {
        clearTimeout(timer); session.pendingLocalClipboard = undefined
        reject(new Error('WORKER_CRASHED'))
      }
    })
  }

  clipboardFilesSet(sessionId: SessionId, paths: string[]): Promise<void> {
    const session = this.requireReady(sessionId)
    if (!session.profile.clipboard || !Array.isArray(paths) || paths.length < 1 || paths.length > MAX_CLIPBOARD_FILES) {
      throw new Error('UNSUPPORTED')
    }
    const files: Array<{ path: string; name: string; size: number; directory?: boolean }> = []
    const seen = new Set<string>()
    let total = 0
    const append = (rawPath: string, name: string): void => {
      if (rawPath.length < 1 || rawPath.length > 32_768 || name.length > 259 ||
          files.length >= MAX_CLIPBOARD_FILES) throw new Error('UNSUPPORTED')
      // Do not traverse junctions or symlinks outside the user's selection.
      if (lstatSync(rawPath).isSymbolicLink()) throw new Error('UNSUPPORTED')
      const normalized = realpathSync(rawPath)
      if (seen.has(normalized)) return
      seen.add(normalized)
      const stats = statSync(normalized)
      if (stats.isDirectory()) {
        files.push({ path: normalized, name, size: 0, directory: true })
        for (const child of readdirSync(normalized)) append(join(normalized, child), name + '\\' + child)
        return
      }
      if (!stats.isFile() || stats.size > MAX_CLIPBOARD_FILE_BYTES || !Number.isSafeInteger(stats.size)) throw new Error('UNSUPPORTED')
      total += stats.size
      if (total > MAX_CLIPBOARD_TOTAL_BYTES) throw new Error('UNSUPPORTED')
      files.push({ path: normalized, name, size: stats.size, directory: false })
    }
    for (const rawPath of paths) {
      if (typeof rawPath !== 'string') throw new Error('UNSUPPORTED')
      append(rawPath, basename(rawPath))
    }
    if (files.length < 1) throw new Error('UNSUPPORTED')
    if (session.clipboardTransfer?.active) throw new Error('TRANSFER_IN_PROGRESS')
    session.clipboardTransfer = { total, fileCount: files.length, active: true }
    this.armClipboardTransferTimeout(session)
    this.emitClipboardProgress(session, 'preparing', { fileCount: files.length, total })
    const requestId = this.nextRequestId(session)
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = session.pendingClipboardFileRequests.get(requestId)
        if (!pending) return
        session.pendingClipboardFileRequests.delete(requestId)
        this.failClipboardTransfer(session, 'CLIPBOARD_TIMEOUT')
        pending.reject(new Error('CLIPBOARD_TIMEOUT'))
      }, CLIPBOARD_TIMEOUT_MS)
      timer.unref()
      session.pendingClipboardFileRequests.set(requestId, { timer, resolve, reject })
      if (this.write(session, 0x18, requestId, { op: 'clipboardFilesSet', files })) return
      const pending = session.pendingClipboardFileRequests.get(requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      session.pendingClipboardFileRequests.delete(requestId)
      this.failClipboardTransfer(session, 'WORKER_CRASHED')
      pending.reject(new Error('WORKER_CRASHED'))
    })
  }

  clipboardGet(sessionId: SessionId): void {
    const session = this.requireReady(sessionId)
    if (!session.profile.clipboard) throw new Error('UNSUPPORTED')
    if (session.pendingClipboardRequests.size > 0) return
    const requestId = this.nextRequestId(session)
    session.pendingClipboardRequests.add(requestId)
    session.clipboardTimer = setTimeout(() => {
      session.clipboardTimer = undefined
      session.pendingClipboardRequests.delete(requestId)
    }, CLIPBOARD_TIMEOUT_MS)
    session.clipboardTimer.unref()
    if (!this.write(session, 0x17, requestId, { op: 'clipboardGet', requestId })) {
      session.pendingClipboardRequests.delete(requestId)
      if (session.clipboardTimer) clearTimeout(session.clipboardTimer)
      session.clipboardTimer = undefined
    }
  }

  /**
   * Enables or disables automatic clipboard mirroring between the local system
   * clipboard and the remote desktop. The renderer reports "RDP tab active and
   * window focused" so a background session never overwrites the local
   * clipboard. Best-effort: the Worker applies the flag asynchronously.
   */
  clipboardSync(sessionId: SessionId, enabled: boolean): void {
    const session = this.sessions.get(sessionId)
    if (!session || !this.isRunning(session) || !session.profile.clipboard) return
    this.write(session, 0x1a, this.nextRequestId(session), { op: 'clipboardSync', enabled })
  }

  /**
   * Explicit "remote file clipboard -> local folder" download. The destination
   * directory is chosen by the renderer through the OS directory picker. The
   * Worker iterates its current remote file manifest and streams each file via
   * CB_FILECONTENTS requests. This resolves once the command is queued to the
   * Worker; real progress/outcome arrives on rdp:clipboardProgress.
   */
  remoteFilesDownload(sessionId: SessionId, directory: string): Promise<void> {
    const session = this.requireReady(sessionId)
    if (!session.profile.clipboard) return Promise.reject(new Error('UNSUPPORTED'))
    const requestId = this.nextRequestId(session)
    if (this.write(session, 0x1b, requestId, { op: 'remoteFilesDownload', directory })) {
      return Promise.resolve()
    }
    return Promise.reject(new Error('WORKER_CRASHED'))
  }

  async close(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await this.beginClose(session, 'user', true)
  }

  async reconnect(sessionId: SessionId): Promise<void> {
    const old = this.sessions.get(sessionId)
    if (!old) throw new Error(t('err.rdp.sessionNotFound'))
    const profile = this.freezeProfile(getProfile(old.profile.id))
    if (!profile) throw new Error(t('err.rdp.profileInvalid'))
    log.info(`RDP reconnect: configuration refreshed; endpointChanged=${profile.host !== old.profile.host || profile.port !== old.profile.port}; identityChanged=${profile.username !== old.profile.username || profile.domain !== old.profile.domain}; credentialReferenceChanged=${profile.passwordRef !== old.profile.passwordRef}`)
    const display = old.display
    const forcePasswordPrompt = old.forcePasswordPrompt || old.failureCode === 'AUTH_FAILED'
    await this.beginClose(old, 'reconnect', false)
    if (this.sessions.get(sessionId) !== old) return
    this.emitState(old, 'reconnecting')
    this.startSession(sessionId, profile, display, forcePasswordPrompt)
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
