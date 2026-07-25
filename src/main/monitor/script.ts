/** 远端采集命令批次模板（写入持久 sh 通道的 stdin） */

export const SENTINEL = {
  begin: (seq: number) => `@@OFS:BEGIN:${seq}@@`,
  end: (seq: number) => `@@OFS:END:${seq}@@`,
  section: (name: string) => `@@OFS:${name}@@`
} as const

export const SECTIONS = ['STAT', 'MEM', 'NET', 'UPTIME', 'LOAD', 'DISKIO', 'DF', 'PS'] as const
export type SectionName = (typeof SECTIONS)[number]

/**
 * 一个采集帧：哨兵行界定输出范围，防 bashrc 输出/欢迎语污染解析。
 * withDf / withPs 按 tick 轮换，避免每 2s 都跑较重的命令。
 * df 用 `timeout 3` 兜住卡死的 NFS 挂载点（探测不到 timeout 时裸跑，靠帧超时兜底）。
 */
export function buildFrame(seq: number, opts: { withDf: boolean; withPs: boolean; hasTimeout: boolean }): string {
  const dfCmd = opts.hasTimeout ? 'timeout 3 df -kP' : 'df -kP'
  const lines = [
    `echo "${SENTINEL.begin(seq)}"`,
    `echo "${SENTINEL.section('STAT')}"`,
    'cat /proc/stat 2>/dev/null',
    `echo "${SENTINEL.section('MEM')}"`,
    'cat /proc/meminfo 2>/dev/null',
    `echo "${SENTINEL.section('NET')}"`,
    'cat /proc/net/dev 2>/dev/null',
    `echo "${SENTINEL.section('UPTIME')}"`,
    'cat /proc/uptime 2>/dev/null',
    `echo "${SENTINEL.section('LOAD')}"`,
    'cat /proc/loadavg 2>/dev/null',
    `echo "${SENTINEL.section('DISKIO')}"`,
    'cat /proc/diskstats 2>/dev/null'
  ]
  if (opts.withDf) {
    lines.push(`echo "${SENTINEL.section('DF')}"`, `${dfCmd} 2>/dev/null`)
  }
  if (opts.withPs) {
    lines.push(
      `echo "${SENTINEL.section('PS')}"`,
      'ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 9'
    )
  }
  lines.push(`echo "${SENTINEL.end(seq)}"`)
  return `${lines.join('\n')}\n`
}

/** 连接就绪后跑一次的静态信息采集 */
export function buildStaticFrame(): string {
  return [
    `echo "${SENTINEL.begin(0)}"`,
    `echo "${SENTINEL.section('UNAME')}"`,
    'uname -srm 2>/dev/null',
    `echo "${SENTINEL.section('HOSTNAME')}"`,
    'hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null',
    `echo "${SENTINEL.section('NPROC')}"`,
    'nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null',
    `echo "${SENTINEL.section('OSRELEASE')}"`,
    'cat /etc/os-release 2>/dev/null',
    `echo "${SENTINEL.section('IPADDR')}"`,
    'ip -o -4 addr 2>/dev/null || ifconfig 2>/dev/null',
    `echo "${SENTINEL.section('HASTIMEOUT')}"`,
    'command -v timeout >/dev/null 2>&1 && echo yes || echo no',
    `echo "${SENTINEL.end(0)}"`
  ].join('\n') + '\n'
}

/** 把一帧原文按 section 哨兵切开 */
export function splitSections(frameBody: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /^@@OFS:([A-Z]+)@@$/
  let current: string | null = null
  let buffer: string[] = []
  for (const line of frameBody.split('\n')) {
    const m = re.exec(line.trim())
    if (m) {
      if (current) out.set(current, buffer.join('\n'))
      current = m[1]
      buffer = []
      continue
    }
    if (current) buffer.push(line)
  }
  if (current) out.set(current, buffer.join('\n'))
  return out
}
