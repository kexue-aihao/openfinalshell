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
