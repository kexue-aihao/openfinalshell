/**
 * /proc 与 df 输出的解析纯函数（无副作用、可单测）。
 * 计数器类指标（CPU jiffies / 网卡字节 / 磁盘扇区）需要两帧差分，由 diff* 函数完成。
 */

// ---------------- /proc/stat ----------------
export interface CpuTimes {
  /** 全部字段之和 */
  total: number
  /** idle + iowait */
  idle: number
}

export interface CpuStat {
  all: CpuTimes
  cores: CpuTimes[]
}

function parseCpuLine(fields: number[]): CpuTimes {
  // user nice system idle iowait irq softirq steal guest guest_nice
  const total = fields.reduce((sum, v) => sum + v, 0)
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0)
  return { total, idle }
}

export function parseProcStat(text: string): CpuStat | null {
  let all: CpuTimes | null = null
  const cores: CpuTimes[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('cpu')) continue
    const parts = line.trim().split(/\s+/)
    const label = parts[0]
    const fields = parts.slice(1).map(Number).filter((n) => Number.isFinite(n))
    if (fields.length < 4) continue
    if (label === 'cpu') all = parseCpuLine(fields)
    else cores.push(parseCpuLine(fields))
  }
  return all ? { all, cores } : null
}

/** 两帧 jiffies 差分 → 使用率百分比（0~100） */
export function diffCpuPct(prev: CpuTimes, next: CpuTimes): number {
  const totalDelta = next.total - prev.total
  const idleDelta = next.idle - prev.idle
  if (totalDelta <= 0) return 0
  const pct = (1 - idleDelta / totalDelta) * 100
  return Math.min(100, Math.max(0, Number(pct.toFixed(1))))
}

// ---------------- /proc/meminfo ----------------
export interface MemInfo {
  totalKb: number
  availableKb: number
  usedKb: number
  buffCacheKb: number
  swapTotalKb: number
  swapUsedKb: number
}

export function parseMeminfo(text: string): MemInfo | null {
  const map = new Map<string, number>()
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line.trim())
    if (m) map.set(m[1], Number(m[2]))
  }
  const totalKb = map.get('MemTotal')
  if (!totalKb) return null

  const buffers = map.get('Buffers') ?? 0
  const cached = map.get('Cached') ?? 0
  const sReclaimable = map.get('SReclaimable') ?? 0
  const buffCacheKb = buffers + cached + sReclaimable
  // MemAvailable 是内核算好的可用量；老内核（<3.14）缺失时退回 free+buff/cache
  const availableKb = map.get('MemAvailable') ?? (map.get('MemFree') ?? 0) + buffCacheKb
  const swapTotalKb = map.get('SwapTotal') ?? 0
  const swapFreeKb = map.get('SwapFree') ?? 0

  return {
    totalKb,
    availableKb,
    usedKb: Math.max(0, totalKb - availableKb),
    buffCacheKb,
    swapTotalKb,
    swapUsedKb: Math.max(0, swapTotalKb - swapFreeKb)
  }
}

// ---------------- /proc/net/dev ----------------
export interface IfaceCounters {
  iface: string
  rxBytes: number
  txBytes: number
}

/** 回环与虚拟网卡不计入速率展示 */
const SKIP_IFACE = /^(lo|docker\d*|veth|br-|virbr|tun\d*|tap\d*)/

export function parseNetDev(text: string, includeAll = false): IfaceCounters[] {
  const out: IfaceCounters[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*([\w.:-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const iface = m[1].replace(/:$/, '')
    if (!includeAll && SKIP_IFACE.test(iface)) continue
    const fields = m[2].trim().split(/\s+/).map(Number)
    if (fields.length < 9 || !Number.isFinite(fields[0])) continue
    out.push({ iface, rxBytes: fields[0], txBytes: fields[8] })
  }
  return out
}

/** 计数器差分 → 每秒字节数；计数器回绕（重启/溢出）时按 0 处理 */
export function diffRate(prev: number, next: number, elapsedSec: number): number {
  if (elapsedSec <= 0) return 0
  const delta = next - prev
  if (delta < 0) return 0
  return Math.round(delta / elapsedSec)
}

// ---------------- /proc/diskstats ----------------
export interface DiskCounters {
  dev: string
  readSectors: number
  writeSectors: number
}

/** 分区（sda1）与虚拟设备不单独统计，只看整盘 */
const REAL_DISK = /^(sd[a-z]|nvme\d+n\d+|vd[a-z]|xvd[a-z]|hd[a-z]|mmcblk\d+)$/

export function parseDiskstats(text: string): DiskCounters[] {
  const out: DiskCounters[] = []
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10) continue
    const dev = f[2]
    if (!REAL_DISK.test(dev)) continue
    out.push({ dev, readSectors: Number(f[5]), writeSectors: Number(f[9]) })
  }
  return out.filter((d) => Number.isFinite(d.readSectors) && Number.isFinite(d.writeSectors))
}

export const SECTOR_BYTES = 512

// ---------------- /proc/uptime & loadavg ----------------
export function parseUptime(text: string): number {
  const value = Number(text.trim().split(/\s+/)[0])
  return Number.isFinite(value) ? Math.floor(value) : 0
}

export function parseLoadAvg(text: string): [number, number, number] {
  const f = text.trim().split(/\s+/).map(Number)
  return [f[0] || 0, f[1] || 0, f[2] || 0]
}

// ---------------- df -kP ----------------
export interface FsUsage {
  fs: string
  mount: string
  totalKb: number
  usedKb: number
  usePct: number
}

/** 只保留真实文件系统；tmpfs/devtmpfs/overlay 等不展示 */
const SKIP_FS = /^(tmpfs|devtmpfs|udev|overlay|squashfs|none|shm|cgroup)/

export function parseDf(text: string): FsUsage[] {
  const out: FsUsage[] = []
  const lines = text.trim().split('\n')
  for (const line of lines.slice(1)) {
    // df -kP 保证单行输出：Filesystem 1024-blocks Used Available Capacity Mounted-on
    const f = line.trim().split(/\s+/)
    if (f.length < 6) continue
    const [fs, totalRaw, usedRaw] = f
    if (SKIP_FS.test(fs)) continue
    const totalKb = Number(totalRaw)
    const usedKb = Number(usedRaw)
    if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || totalKb <= 0) continue
    out.push({
      fs,
      mount: f.slice(5).join(' '),
      totalKb,
      usedKb,
      usePct: Number(((usedKb / totalKb) * 100).toFixed(1))
    })
  }
  return out
}

// ---------------- /proc/net/sockstat（+ sockstat6） ----------------
export interface SockStat {
  socketsUsed: number
  tcpInuse: number
  tcpOrphan: number
  tcpTw: number
  udpInuse: number
}

/**
 * 解析 sockstat 与 sockstat6 拼在一起的文本：
 *
 *   sockets: used 337
 *   TCP: inuse 12 orphan 0 tw 3 alloc 20 mem 2
 *   UDP: inuse 6 mem 3
 *   TCP6: inuse 4
 *   UDP6: inuse 1
 *
 * v4 与 v6 相加。`sockets: used` 只在 sockstat 里有（v6 那份没有这行）。
 * 一个键都认不出来时返回 null —— 文件不存在（非 Linux / 极简容器）时正是这样。
 */
export function parseSockstat(text: string): SockStat | null {
  const out = { socketsUsed: 0, tcpInuse: 0, tcpOrphan: 0, tcpTw: 0, udpInuse: 0 }
  let hit = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const m = /^(sockets|TCP6?|UDP6?|UDPLITE6?|RAW6?|FRAG6?):\s+(.*)$/.exec(line)
    if (!m) continue
    const [, kind, rest] = m
    const fields = new Map<string, number>()
    const parts = rest.split(/\s+/)
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const value = Number(parts[i + 1])
      if (Number.isFinite(value)) fields.set(parts[i], value)
    }
    if (kind === 'sockets') {
      const used = fields.get('used')
      if (used !== undefined) {
        out.socketsUsed += used
        hit = true
      }
      continue
    }
    if (kind !== 'TCP' && kind !== 'TCP6' && kind !== 'UDP' && kind !== 'UDP6') continue
    const inuse = fields.get('inuse')
    if (inuse === undefined) continue
    hit = true
    if (kind.startsWith('TCP')) {
      out.tcpInuse += inuse
      // orphan / tw 只在 IPv4 那份里有
      out.tcpOrphan += fields.get('orphan') ?? 0
      out.tcpTw += fields.get('tw') ?? 0
    } else {
      out.udpInuse += inuse
    }
  }
  return hit ? out : null
}

// ---------------- /proc/net/tcp 的状态直方图 ----------------
/** /proc/net/tcp 第 4 列的十六进制状态码 */
const TCP_STATE_NAMES: Record<string, string> = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
  '0C': 'NEW_SYN_RECV'
}

/**
 * 解析服务器侧 awk 聚合出的 `<十六进制状态> <数量>` 行。
 * 认不出的状态码按 `UNKNOWN_xx` 保留而不是丢掉 —— 丢掉会让总数对不上，
 * 而"对不上"是最难查的那种问题。
 */
export function parseTcpStates(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const raw of text.split('\n')) {
    const m = /^([0-9A-Fa-f]{1,2})\s+(\d+)$/.exec(raw.trim())
    if (!m) continue
    const code = m[1].toUpperCase().padStart(2, '0')
    const count = Number(m[2])
    if (!Number.isFinite(count)) continue
    const name = TCP_STATE_NAMES[code] ?? `UNKNOWN_${code}`
    out[name] = (out[name] ?? 0) + count
  }
  return out
}

// ---------------- 静态信息 ----------------
export interface StaticInfoRaw {
  uname: string
  hostname: string
  nproc: string
  osRelease: string
  ipAddr: string
}

export function parseStaticInfo(raw: StaticInfoRaw): {
  hostname: string
  kernel: string
  arch: string
  distro: string
  cpuCores: number
  ips: string[]
} {
  const unameParts = raw.uname.trim().split(/\s+/)
  const prettyName = /^PRETTY_NAME="?(.+?)"?$/m.exec(raw.osRelease)?.[1]
  const nameOnly = /^NAME="?(.+?)"?$/m.exec(raw.osRelease)?.[1]
  const ips = [...raw.ipAddr.matchAll(/inet\s+(\d+\.\d+\.\d+\.\d+)/g)]
    .map((m) => m[1])
    .filter((ip) => ip !== '127.0.0.1')

  return {
    hostname: raw.hostname.trim(),
    kernel: unameParts[1] ?? '',
    arch: unameParts[2] ?? '',
    distro: prettyName ?? nameOnly ?? unameParts[0] ?? '',
    cpuCores: Math.max(1, Number(raw.nproc.trim()) || 1),
    ips
  }
}

// ---------------- ps（进程 Top，best-effort） ----------------
export interface ProcInfo {
  pid: number
  name: string
  cpuPct: number
  memPct: number
}

/** BusyBox 的 TIME 列形如 0:00 / 12:34:56 —— 用形状认，别用 Number() 的 NaN 反证 */
const BUSYBOX_TIME = /^\d+:\d+/

/**
 * 解析 `ps aux` 变体的输出（procps 的 `-eo --sort` 不可用时的回落路径）。
 * 三种真实存在的行形态，逐行嗅探：
 *
 *   完整 aux（BSD/procps 无 --sort 的场景）：
 *     USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND...   ← ≥11 列，2~4 列全是数
 *   BusyBox DESKTOP 构建（Alpine）：
 *     PID USER TIME COMMAND...                                    ← 第 3 列形如 "0:00"
 *   BusyBox 非 DESKTOP 构建（OpenWrt 默认）：
 *     PID USER VSZ STAT COMMAND...                                ← 第 3 列是 VSZ（可带 m 后缀），第 4 列 STAT 以字母开头
 *
 * BusyBox 给不出 %CPU/%MEM —— 填 0 而不是编数字；进程名单本身就是这张卡片的价值。
 * 表头行（USER/PID 打头）天然过不了数字校验，无需特判。
 */
export function parsePsAux(text: string, limit = 8): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const line of text.trim().split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue
    const nums = f.slice(0, 4).map(Number)
    if (f.length >= 11 && Number.isFinite(nums[1]) && Number.isFinite(nums[2]) && Number.isFinite(nums[3])) {
      // 完整 aux：USER 可能是纯数字 uid，所以判据放在 2~4 列上
      out.push({ pid: nums[1], cpuPct: nums[2], memPct: nums[3], name: f.slice(10).join(' ') })
    } else if (Number.isFinite(nums[0]) && BUSYBOX_TIME.test(f[2])) {
      // Alpine 形态：PID USER TIME COMMAND。TIME 必须按形状认 ——
      // 用 !isFinite(第3列) 反证的话，OpenWrt 形态里带后缀的 VSZ（"129m"）会误入这里，
      // 把 STAT 字母粘进进程名
      out.push({ pid: nums[0], cpuPct: 0, memPct: 0, name: f.slice(3).join(' ') })
    } else if (f.length >= 5 && Number.isFinite(nums[0]) && !Number.isFinite(nums[1]) && /^[A-Za-z]/.test(f[3])) {
      // OpenWrt 形态：PID USER VSZ STAT COMMAND。VSZ 数字或带 m/g 后缀都可能；
      // STAT（S/R/SW/S< …）以字母开头，而命令列几乎总以 / 或 [ 开头，借此与 TIME 形态互斥。
      // !isFinite(nums[1]) 把「USER 是纯数字 uid 的完整 aux 短行」挡在门外（那种行归上面）
      out.push({ pid: nums[0], cpuPct: 0, memPct: 0, name: f.slice(4).join(' ') })
    } else {
      continue
    }
    if (out.length >= limit) break
  }
  // 服务器侧的 sort 在 BusyBox 输出上排不出正确顺序，这里按 CPU 收一次尾；
  // 全 0 时 sort 稳定，名单顺序保持服务器给出的原样
  return out.sort((a, b) => b.cpuPct - a.cpuPct)
}

/** 解析 `ps -eo pid,pcpu,pmem,comm --sort=-pcpu` 的输出 */
export function parsePsTop(text: string, limit = 8): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const line of text.trim().split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue
    const pid = Number(f[0])
    const cpuPct = Number(f[1])
    const memPct = Number(f[2])
    if (!Number.isFinite(pid) || !Number.isFinite(cpuPct)) continue
    out.push({ pid, cpuPct, memPct: Number.isFinite(memPct) ? memPct : 0, name: f.slice(3).join(' ') })
    if (out.length >= limit) break
  }
  return out
}
