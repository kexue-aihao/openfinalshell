import type { ClientChannel } from 'ssh2'
import type { PortTrafficEntry, PortTrafficSnapshot, PortTrafficState, SessionId } from '@shared/types'
import {
  PORT_TRAFFIC_FRAME_TIMEOUT_MS,
  PORT_TRAFFIC_INTERVAL_MS,
  PORT_TRAFFIC_MAX_FRAME_BYTES
} from '@shared/constants'
import { t } from '../services/i18n'
import { scopedLogger } from '../utils/logger'
import { buildPortTrafficFrame } from './portTrafficScript'
import { splitSections } from './script'

const log = scopedLogger('port-traffic')
const FRAME_RE = /@@OFS:BEGIN:(\d+)@@\r?\n([\s\S]*?)@@OFS:END:\1@@\r?\n?/
const MAX_CONSECUTIVE_FAILURES = 3

export interface PortTrafficCallbacks {
  onSnapshot: (snapshot: PortTrafficSnapshot) => void
  onState: (state: PortTrafficState, error?: string) => void
}

interface PortCounters {
  connections: number
  rxBytes: number
  txBytes: number
}

interface PreviousCounters extends PortCounters {
  ts: number
}

/**
 * 解析远端 awk 已聚合的端口计数。远端输出不可信，所以所有字段均严格限于有限数字；
 * 一条坏行不能让整页停止，异常数量或字节数也不允许进入渲染进程。
 */
export function parsePortCounters(text: string): Map<number, PortCounters> {
  const out = new Map<number, PortCounters>()
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 4) continue
    const [portText, connectionsText, rxText, txText] = fields
    const port = Number(portText)
    const connections = Number(connectionsText)
    const rxBytes = Number(rxText)
    const txBytes = Number(txText)
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !Number.isSafeInteger(connections) ||
      connections < 1 ||
      !Number.isSafeInteger(rxBytes) ||
      rxBytes < 0 ||
      !Number.isSafeInteger(txBytes) ||
      txBytes < 0
    ) {
      continue
    }
    out.set(port, { connections, rxBytes, txBytes })
  }
  return out
}

/**
 * 打开端口流量标签后才运行的独立采集器。它不复用服务器监控通道，避免大 socket
 * 表的采集拖慢 CPU/磁盘/网卡指标；也不用每秒新建 exec，以免耗尽 sshd 的 MaxSessions。
 */
export class PortTrafficCollector {
  private channel: ClientChannel | null = null
  private buffer = ''
  private seq = 0
  private timer: NodeJS.Timeout | null = null
  private frameTimer: NodeJS.Timeout | null = null
  private pending: { seq: number; resolve: (body: string | null) => void } | null = null
  private previous = new Map<number, PreviousCounters>()
  private failures = 0
  private stopped = false
  state: PortTrafficState = 'stopped'

  constructor(
    readonly sessionId: SessionId,
    private readonly openChannel: () => Promise<ClientChannel>,
    private readonly cb: PortTrafficCallbacks
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    this.pause()
    await this.open()
  }

  async reattach(): Promise<void> {
    if (this.stopped || this.state === 'unsupported') return
    this.pause()
    this.channel?.close()
    this.channel = null
    this.pending?.resolve(null)
    this.pending = null
    await this.open()
  }

  stop(): void {
    this.stopped = true
    this.pause()
    this.channel?.close()
    this.channel = null
    this.pending?.resolve(null)
    this.pending = null
    this.previous.clear()
    this.setState('stopped')
  }

  private async open(): Promise<void> {
    this.setState('running')
    const channel = await this.openChannel()
    if (this.stopped) {
      channel.close()
      return
    }
    this.channel = channel
    channel.on('data', (chunk: Buffer) => this.onData(chunk))
    channel.stderr.on('data', () => {
      /* ss 的能力/权限问题按正文和帧超时处理，不让 stderr 污染协议流 */
    })
    channel.on('close', () => this.onChannelClosed(channel))
    this.timer = setInterval(() => this.tick(), PORT_TRAFFIC_INTERVAL_MS)
    this.tick()
  }

  private pause(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.frameTimer) clearTimeout(this.frameTimer)
    this.frameTimer = null
  }

  private setState(state: PortTrafficState, error?: string): void {
    if (this.state === state && error === undefined) return
    this.state = state
    this.cb.onState(state, error)
  }

  private tick(): void {
    if (this.stopped || !this.channel || this.pending) return
    this.seq += 1
    const seq = this.seq
    void this.request(buildPortTrafficFrame(seq), seq).then((body) => {
      if (body === null) {
        this.onFailure(t('err.net.collectTimeout'))
        return
      }
      const sections = splitSections(body)
      if (sections.has('NOSS')) {
        this.pause()
        this.setState('unsupported')
        return
      }
      try {
        this.publish(parsePortCounters(sections.get('PORTS') ?? ''))
        this.failures = 0
        if (this.state !== 'running') this.setState('running')
      } catch (err) {
        this.onFailure(err instanceof Error ? err.message : String(err))
      }
    })
  }

  private request(script: string, seq: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.channel) return resolve(null)
      this.pending = { seq, resolve }
      this.frameTimer = setTimeout(() => {
        if (this.pending?.seq !== seq) return
        this.pending = null
        this.frameTimer = null
        resolve(null)
      }, PORT_TRAFFIC_FRAME_TIMEOUT_MS)
      this.channel.write(script)
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    if (Buffer.byteLength(this.buffer, 'utf8') > PORT_TRAFFIC_MAX_FRAME_BYTES) {
      this.buffer = ''
      const pending = this.pending
      if (pending) {
        this.pending = null
        if (this.frameTimer) clearTimeout(this.frameTimer)
        this.frameTimer = null
        pending.resolve(null)
      }
      this.onFailure('port traffic response exceeded the safety limit')
      return
    }

    // 帧超时后，远端的旧响应仍可能与下一次请求的响应一起到达。持续丢掉过期帧，
    // 直到命中当前 pending 的 seq；否则同一 chunk 里的有效新帧会被误认为超时。
    let match: RegExpExecArray | null
    while ((match = FRAME_RE.exec(this.buffer))) {
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const seq = Number(match[1])
      if (!this.pending || this.pending.seq !== seq) continue
      if (this.frameTimer) clearTimeout(this.frameTimer)
      this.frameTimer = null
      const { resolve } = this.pending
      this.pending = null
      resolve(match[2])
      return
    }
  }

  private publish(counters: Map<number, PortCounters>): void {
    const now = Date.now()
    const next = new Map<number, PreviousCounters>()
    const ports: PortTrafficEntry[] = []
    for (const [port, current] of counters) {
      const previous = this.previous.get(port)
      const elapsed = previous ? Math.max(0.001, (now - previous.ts) / 1000) : 0
      const rxDelta = previous ? Math.max(0, current.rxBytes - previous.rxBytes) : 0
      const txDelta = previous ? Math.max(0, current.txBytes - previous.txBytes) : 0
      ports.push({
        port,
        connections: current.connections,
        rxBps: elapsed ? Math.round(rxDelta / elapsed) : 0,
        txBps: elapsed ? Math.round(txDelta / elapsed) : 0
      })
      next.set(port, { ...current, ts: now })
    }
    this.previous = next
    ports.sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps) || b.connections - a.connections || a.port - b.port)
    this.cb.onSnapshot({ ts: now, ports })
  }

  private onFailure(reason: string): void {
    if (this.stopped) return
    this.failures += 1
    log.debug(`session ${this.sessionId}: port traffic failed (${this.failures}) ${reason}`)
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.pause()
      this.setState('failed', reason)
    }
  }

  private onChannelClosed(channel: ClientChannel): void {
    if (this.channel !== channel) return
    this.channel = null
    this.pause()
    if (this.pending) {
      const { resolve } = this.pending
      this.pending = null
      resolve(null)
    }
    if (!this.stopped && this.state === 'running') this.onFailure('port traffic channel closed')
  }
}
