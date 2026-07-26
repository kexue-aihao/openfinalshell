/** 远端采集命令批次模板（写入持久 sh 通道的 stdin） */

export const SENTINEL = {
  begin: (seq: number) => `@@OFS:BEGIN:${seq}@@`,
  end: (seq: number) => `@@OFS:END:${seq}@@`,
  section: (name: string) => `@@OFS:${name}@@`
} as const

/**
 * ⚠️ 段名只能是**大写字母**：splitSections 用 /^@@OFS:([A-Z]+)@@$/ 认段。
 * `TCP_UDP`、`CONN2` 这类名字不会报错，会静默并进上一段的正文里。
 * 这个数组是纯文档（没人引用），不会替你把名字检查住。
 */
export const SECTIONS = [
  'STAT',
  'MEM',
  'NET',
  'UPTIME',
  'LOAD',
  'DISKIO',
  'SOCK',
  'DF',
  'PS',
  'TCPST'
] as const
export type SectionName = (typeof SECTIONS)[number]

/**
 * 按状态统计 TCP 连接：在服务器侧用 awk 聚合成十几行再回传。
 *
 * 绝不能把 /proc/net/tcp 原文拉回来 —— 每条 socket 约 150 字节，20 万连接就是
 * 每 tick 30MB，而 MonitorCollector 会把整条通道拼进一个 JS 字符串、每来一个 chunk
 * 都在整个缓冲上跑一次正则，4MB 时截断且保留尾部（于是 BEGIN 哨兵丢失 → 帧必然超时
 * → 连续三次把面板打成 failed）。三条保护会被同时踩中。
 *
 * FNR>1 跳掉**每个文件各自的**表头（表头第 4 列字面就是 `st`，不跳会多出一个假状态）。
 */
const TCP_STATE_AWK =
  `awk 'FNR>1{c[$4]++} END{for(k in c) printf "%s %d\\n", k, c[k]}' ` +
  '/proc/net/tcp /proc/net/tcp6'

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
    'cat /proc/diskstats 2>/dev/null',
    // 内核已经维护好的聚合计数，读它与连接数无关（输出十几字节），所以每 tick 都能采。
    // sockstat6 在关掉 IPv6 的机器上不存在 —— cat 的报错被吞掉，解析侧按缺失容忍。
    `echo "${SENTINEL.section('SOCK')}"`,
    'cat /proc/net/sockstat /proc/net/sockstat6 2>/dev/null'
  ]
  if (opts.withDf) {
    lines.push(`echo "${SENTINEL.section('DF')}"`, `${dfCmd} 2>/dev/null`)
    // 与 df 同一档低频 tick：awk 要走完整张 socket 表，代价在服务器 CPU。
    // timeout 探测不到就裸跑，靠帧超时兜底（与 df 同一套处置）。
    lines.push(
      `echo "${SENTINEL.section('TCPST')}"`,
      `${opts.hasTimeout ? 'timeout 3 ' : ''}${TCP_STATE_AWK} 2>/dev/null`
    )
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
