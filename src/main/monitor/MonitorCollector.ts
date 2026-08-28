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
  parsePsAux,
  parsePsTop,
  parseSockstat,
  parseStaticInfo,
  parseTcpStates,
  parseUptime,
  SECTOR_BYTES,
  type CpuStat,
  type DiskCounters,
  type IfaceCounters
} from './parsers'
import { buildFrame, buildStaticFrame, SENTINEL, splitSections } from './script'
import { probeDirectLatency } from './directLatency'
import { scopedLogger } from '../utils/logger'
import { t } from '../services/i18n'

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
  /** procps 的 `-eo --sort` 是否可用；探测前按可用处理（等于今天的既有行为） */
  private hasPsSort = true
  /**
   * 最近一次帧首哨兵回显的往返毫秒。帧首那句 `echo BEGIN` 服务器收到即回显，
   * 写入→首见 BEGIN ≈ 一个 SSH 通道往返 —— 不必像 pixshell 那样反复对 22 端口
   * 开 TCP 连接测延迟（那会刷一屏 sshd 的 "did not receive identification string"）。
   */
  private lastConnectionLatencyMs: number | null = null
  /** 直连 Ping 是 best-effort：不可用不影响 SSH 监控，也绝不能拖慢它。 */
  private lastDirectLatencyMs: number | null = null
  private directLatencyInFlight = false
  private directLatencyAbort: AbortController | null = null
  private stopped = false
  private lastDfTick = -MONITOR_DF_EVERY_N_TICKS
  private lastDiskFs: MonitorSnapshot['diskFs'] = null
  state: CollectorState = 'starting'

  constructor(
    readonly sessionId: SessionId,
    private readonly openChannel: () => Promise<ClientChannel>,
    private readonly cb: CollectorCallbacks,
    /** 连接配置里的目标；由本机 ping 它，不使用服务器自报的可能是内网的地址。 */
    private readonly directLatencyTarget?: string,
    private readonly directLatencyProbe: (target: string, signal: AbortSignal) => Promise<number | null> =
      probeDirectLatency
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
    // 重建通道时必须先停掉旧 tick，否则每次重建都多挂一个 interval，采集频率翻倍
    this.pause()
    this.setInterval(intervalMs)
    const channel = await this.openChannel()
    this.channel = channel
    channel.on('data', (chunk: Buffer) => this.onData(chunk))
    channel.stderr.on('data', () => {
      /* 采集脚本的 stderr 已重定向，此处忽略残余 */
    })
    // 带上通道身份：旧通道的 close 迟到时不能把刚建好的新通道置空
    channel.on('close', () => this.onChannelClosed(channel))

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
    // 段缺失（不该发生）时保持 procps 路径 —— 与探测机制上线前的行为一致
    this.hasPsSort = (sections.get('HASPSSORT') ?? 'yes').includes('yes')
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
      this.pendingFrame = { seq, resolve, writtenAt: Date.now(), beginSeen: false }
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

  private pendingFrame: {
    seq: number
    resolve: (body: string | null) => void
    /** 延迟打点：channel.write 的时刻 */
    writtenAt: number
    /** BEGIN 哨兵只打一次点（后续 chunk 不再扫） */
    beginSeen: boolean
  } | null = null

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    // 缓冲上限保护：畸形输出时不无限增长
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = this.buffer.slice(-1024 * 1024)

    // 延迟打点：首见本帧 BEGIN 哨兵即记一次往返。只在还没见到时扫（帧首 chunk 就会命中，
    // 后续 chunk 走的是 boolean 短路，不会在 4MB 缓冲上反复 indexOf）
    const pending = this.pendingFrame
    if (pending && !pending.beginSeen && this.buffer.includes(SENTINEL.begin(pending.seq))) {
      pending.beginSeen = true
      this.lastConnectionLatencyMs = Date.now() - pending.writtenAt
    }

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
    this.measureDirectLatency()
    this.seq += 1
    const seq = this.seq
    const withDf = seq - this.lastDfTick >= MONITOR_DF_EVERY_N_TICKS
    if (withDf) this.lastDfTick = seq
    const withPs = withDf // 与 df 同 tick，摊平重命令开销

    void this.request(
      buildFrame(seq, { withDf, withPs, hasTimeout: this.hasTimeoutCmd, hasPsSort: this.hasPsSort }),
      seq
    ).then((body) => {
      if (body === null) {
        this.onFailure(t('err.net.collectTimeout'))
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
      this.onFailure(t('err.net.parseProcFailed'))
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
    const tcpStText = sections.get('TCPST')

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
      conns: parseSockstat(sections.get('SOCK') ?? ''),
      // best-effort：这一段只在低频 tick 出现，缺失时给 undefined 让 renderer 沿用上次值
      tcpStates: tcpStText ? parseTcpStates(tcpStText) : undefined,
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
      topProcs: psText ? (this.hasPsSort ? parsePsTop(psText) : parsePsAux(psText)) : undefined,
      directLatencyMs: this.lastDirectLatencyMs ?? undefined,
      connectionLatencyMs: this.lastConnectionLatencyMs ?? undefined
    }
  }

  /** 每个监控 tick 至多一条 ping；上一次未结束时跳过，避免丢包时堆积子进程。 */
  private measureDirectLatency(): void {
    if (!this.directLatencyTarget || this.directLatencyInFlight || this.stopped) return
    const controller = new AbortController()
    this.directLatencyAbort = controller
    this.directLatencyInFlight = true
    void this.directLatencyProbe(this.directLatencyTarget, controller.signal)
      .then((latencyMs) => {
        if (!this.stopped) this.lastDirectLatencyMs = latencyMs
      })
      .catch(() => {
        // 直连测量的失败只代表 ping 不可用，绝不将整个服务器监控置为 failed。
        if (!this.stopped) this.lastDirectLatencyMs = null
      })
      .finally(() => {
        if (this.directLatencyAbort === controller) this.directLatencyAbort = null
        this.directLatencyInFlight = false
      })
  }

  private onFailure(reason: string): void {
    // stop() 会把在途帧以 null 收尾，别让它把已停止的采集器翻成 failed
    if (this.stopped) return
    this.failures += 1
    log.debug(`session ${this.sessionId}: collect failed (${this.failures}) ${reason}`)
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.setState('failed', reason)
      this.pause()
    }
  }

  private onChannelClosed(channel: ClientChannel): void {
    if (this.channel !== channel) return
    this.channel = null
    this.pause()
    // 在途帧永远等不到应答了，就地收尾 —— 否则 pendingFrame 一直占着，tick() 全被挡掉
    if (this.frameTimer) {
      clearTimeout(this.frameTimer)
      this.frameTimer = null
    }
    this.pendingFrame?.resolve(null)
    this.pendingFrame = null
    if (this.stopped) return
    // 通道被杀（如服务器侧 kill 了 sh）：5s 后重建。
    // 整条 SSH 连接断了的情况由 MonitorManager.reattach 在重连成功后驱动。
    log.debug(`session ${this.sessionId}: monitor channel closed, retrying in 5s`)
    setTimeout(() => {
      if (this.stopped || this.channel) return
      void this.restart()
    }, 5000)
  }

  /**
   * 会话重连成功后重建采集通道。
   * 旧通道即使还没触发 close 也已经废了（它挂在旧连接上），所以无条件换新的 ——
   * 只等 close 事件的话，会白等到那 5s 重试才恢复。
   */
  async reattach(): Promise<void> {
    if (this.stopped) return
    const stale = this.channel
    this.channel = null
    stale?.close()
    await this.restart()
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
    this.directLatencyAbort?.abort()
    this.directLatencyAbort = null
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
