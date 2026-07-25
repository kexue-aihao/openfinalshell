import type { ClientChannel } from 'ssh2'
import type { MonitorSnapshot, MonitorStaticInfo, SessionId } from '@shared/types'
import {
  MONITOR_DEFAULT_INTERVAL_MS,
  MONITOR_DF_EVERY_N_TICKS,
  MONITOR_FRAME_TIMEOUT_MS,
  MONITOR_MAX_INTERVAL_MS,
  MONITOR_MIN_INTERVAL_MS
} from '@shared/constants'
import {
  diffCpuPct,
  diffRate,
  parseDf,
  parseDiskstats,
  parseLoadAvg,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parsePsTop,
  parseStaticInfo,
  parseUptime,
  SECTOR_BYTES,
  type CpuStat,
  type DiskCounters,
  type IfaceCounters
} from './parsers'
import { buildFrame, buildStaticFrame, splitSections } from './script'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('monitor')

const FRAME_RE = /@@OFS:BEGIN:(\d+)@@\n([\s\S]*?)@@OFS:END:\1@@/
/** 连续解析/超时失败达到该次数后置为 failed */
const MAX_CONSECUTIVE_FAILURES = 3

export type CollectorState = 'starting' | 'running' | 'failed' | 'unsupported' | 'stopped'

export interface CollectorCallbacks {
  onSnapshot: (snapshot: MonitorSnapshot) => void
  onState: (state: CollectorState, error?: string) => void
}

interface PrevFrame {
  ts: number
  cpu: CpuStat
  net: IfaceCounters[]
  disk: DiskCounters[]
}

/**
 * 一个会话一个采集器。
 * 通道：`env LANG=C sh` 的 exec 裸通道（无 PTY 回显、常驻仅占 1 个 channel；
 * 用 env 前缀而非 `LANG=C sh` 以兼容登录 shell 为 csh 的情况）。
 * 每 tick 往 stdin 写一个命令批次，用带序号的哨兵行界定输出帧。
 */
export class MonitorCollector {
  private channel: ClientChannel | null = null
  private buffer = ''
  private seq = 0
  private tickTimer: NodeJS.Timeout | null = null
  private frameTimer: NodeJS.Timeout | null = null
  private prev: PrevFrame | null = null
  private failures = 0
  private intervalMs = MONITOR_DEFAULT_INTERVAL_MS
  private hasTimeoutCmd = false
  private stopped = false
  private lastDfTick = -MONITOR_DF_EVERY_N_TICKS
  private lastDiskFs: MonitorSnapshot['diskFs'] = null
  state: CollectorState = 'starting'

  constructor(
    readonly sessionId: SessionId,
    private readonly openChannel: () => Promise<ClientChannel>,
    private readonly cb: CollectorCallbacks
  ) {}

  setInterval(ms: number): void {
    this.intervalMs = Math.min(MONITOR_MAX_INTERVAL_MS, Math.max(MONITOR_MIN_INTERVAL_MS, ms))
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = setInterval(() => this.tick(), this.intervalMs)
    }
  }

  /** 启动：开通道 → 采静态信息 → 开始周期采集。非 Linux 返回 null（面板显示不支持） */
  async start(intervalMs = MONITOR_DEFAULT_INTERVAL_MS): Promise<MonitorStaticInfo | null> {
    this.setInterval(intervalMs)
    this.channel = await this.openChannel()
    this.channel.on('data', (chunk: Buffer) => this.onData(chunk))
    this.channel.stderr.on('data', () => {
      /* 采集脚本的 stderr 已重定向，此处忽略残余 */
    })
    this.channel.on('close', () => this.onChannelClosed())

    const staticInfo = await this.collectStatic()
    if (!staticInfo) {
      this.setState('unsupported')
      return null
    }
    this.setState('running')
    this.tickTimer = setInterval(() => this.tick(), this.intervalMs)
    this.tick()
    return staticInfo
  }

  private async collectStatic(): Promise<MonitorStaticInfo | null> {
    const body = await this.request(buildStaticFrame(), 0)
    if (body === null) return null
    const sections = splitSections(body)
    const uname = sections.get('UNAME') ?? ''
    // 非 Linux（BSD/macOS/Windows sshd）没有 /proc，v1 明确降级
    if (!/^Linux/i.test(uname.trim())) {
      log.info(`session ${this.sessionId}: monitoring unsupported (uname=${uname.trim()})`)
      return null
    }
    this.hasTimeoutCmd = (sections.get('HASTIMEOUT') ?? '').includes('yes')
    return parseStaticInfo({
      uname,
      hostname: sections.get('HOSTNAME') ?? '',
      nproc: sections.get('NPROC') ?? '',
      osRelease: sections.get('OSRELEASE') ?? '',
      ipAddr: sections.get('IPADDR') ?? ''
    })
  }

  /** 写入一帧命令并等待对应哨兵；超时返回 null（帧超时防单条命令卡死整个通道） */
  private request(script: string, seq: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.channel) return resolve(null)
      this.pendingFrame = { seq, resolve }
      this.frameTimer = setTimeout(() => {
        if (this.pendingFrame?.seq === seq) {
          this.pendingFrame = null
          log.debug(`session ${this.sessionId}: frame ${seq} timed out`)
          resolve(null)
        }
      }, MONITOR_FRAME_TIMEOUT_MS)
      this.channel.write(script)
    })
  }

  private pendingFrame: { seq: number; resolve: (body: string | null) => void } | null = null

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    // 缓冲上限保护：畸形输出时不无限增长
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = this.buffer.slice(-1024 * 1024)

    const match = FRAME_RE.exec(this.buffer)
    if (!match) return
    this.buffer = this.buffer.slice(match.index + match[0].length)
    const seq = Number(match[1])
    const body = match[2]

    if (this.pendingFrame && this.pendingFrame.seq === seq) {
      if (this.frameTimer) {
        clearTimeout(this.frameTimer)
        this.frameTimer = null
      }
      const { resolve } = this.pendingFrame
      this.pendingFrame = null
      resolve(body)
    }
  }

  private tick(): void {
    if (this.stopped || !this.channel || this.pendingFrame) return
    this.seq += 1
    const seq = this.seq
    const withDf = seq - this.lastDfTick >= MONITOR_DF_EVERY_N_TICKS
    if (withDf) this.lastDfTick = seq
    const withPs = withDf // 与 df 同 tick，摊平重命令开销

    void this.request(
      buildFrame(seq, { withDf, withPs, hasTimeout: this.hasTimeoutCmd }),
      seq
    ).then((body) => {
      if (body === null) {
        this.onFailure('采集超时')
        return
      }
      try {
        const snapshot = this.buildSnapshot(body)
        if (snapshot) {
          this.failures = 0
          if (this.state !== 'running') this.setState('running')
          this.cb.onSnapshot(snapshot)
        }
      } catch (err) {
        this.onFailure(err instanceof Error ? err.message : String(err))
      }
    })
  }

  /** 首帧只建基线（计数器类指标需要两帧差分），返回 null */
  private buildSnapshot(body: string): MonitorSnapshot | null {
    const sections = splitSections(body)
    const cpu = parseProcStat(sections.get('STAT') ?? '')
    const mem = parseMeminfo(sections.get('MEM') ?? '')
    if (!cpu || !mem) {
      this.onFailure('无法解析 /proc 输出')
      return null
    }

    const ts = Date.now()
    const net = parseNetDev(sections.get('NET') ?? '')
    const disk = parseDiskstats(sections.get('DISKIO') ?? '')
    const prev = this.prev
    this.prev = { ts, cpu, net, disk }

    if (!prev) return null
    const elapsedSec = (ts - prev.ts) / 1000

    const dfText = sections.get('DF')
    if (dfText !== undefined) this.lastDiskFs = parseDf(dfText)
    const psText = sections.get('PS')

    return {
      ts,
      uptimeSec: parseUptime(sections.get('UPTIME') ?? ''),
      cpu: {
        usagePct: diffCpuPct(prev.cpu.all, cpu.all),
        perCore: cpu.cores.map((core, i) =>
          prev.cpu.cores[i] ? diffCpuPct(prev.cpu.cores[i], core) : 0
        ),
        loadAvg: parseLoadAvg(sections.get('LOAD') ?? '')
      },
      mem: {
        totalKb: mem.totalKb,
        availableKb: mem.availableKb,
        usedKb: mem.usedKb,
        swapTotalKb: mem.swapTotalKb,
        swapUsedKb: mem.swapUsedKb
      },
      net: net.map((iface) => {
        const before = prev.net.find((n) => n.iface === iface.iface)
        return {
          iface: iface.iface,
          rxBps: before ? diffRate(before.rxBytes, iface.rxBytes, elapsedSec) : 0,
          txBps: before ? diffRate(before.txBytes, iface.txBytes, elapsedSec) : 0,
          rxTotalBytes: iface.rxBytes,
          txTotalBytes: iface.txBytes
        }
      }),
      diskFs: dfText !== undefined ? this.lastDiskFs : null,
      diskIo: disk.map((d) => {
        const before = prev.disk.find((x) => x.dev === d.dev)
        return {
          dev: d.dev,
          readBps: before ? diffRate(before.readSectors, d.readSectors, elapsedSec) * SECTOR_BYTES : 0,
          writeBps: before
            ? diffRate(before.writeSectors, d.writeSectors, elapsedSec) * SECTOR_BYTES
            : 0
        }
      }),
      topProcs: psText ? parsePsTop(psText) : undefined
    }
  }

  private onFailure(reason: string): void {
    this.failures += 1
    log.debug(`session ${this.sessionId}: collect failed (${this.failures}) ${reason}`)
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.setState('failed', reason)
      this.pause()
    }
  }

  private onChannelClosed(): void {
    this.channel = null
    if (this.stopped) return
    // 通道被杀（如服务器侧重启 shell）：5s 后重建
    log.debug(`session ${this.sessionId}: monitor channel closed, retrying in 5s`)
    setTimeout(() => {
      if (this.stopped) return
      void this.restart()
    }, 5000)
  }

  private async restart(): Promise<void> {
    try {
      this.prev = null
      this.buffer = ''
      await this.start(this.intervalMs)
    } catch (err) {
      this.onFailure(err instanceof Error ? err.message : String(err))
    }
  }

  private pause(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  private setState(state: CollectorState, error?: string): void {
    this.state = state
    this.cb.onState(state, error)
  }

  stop(): void {
    this.stopped = true
    this.pause()
    if (this.frameTimer) {
      clearTimeout(this.frameTimer)
      this.frameTimer = null
    }
    this.pendingFrame?.resolve(null)
    this.pendingFrame = null
    this.channel?.close()
    this.channel = null
    this.setState('stopped')
  }
}
