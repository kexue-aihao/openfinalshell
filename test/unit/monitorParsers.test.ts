import { describe, expect, it } from 'vitest'
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
  parseSockstat,
  parseStaticInfo,
  parseTcpStates,
  parseUptime
} from '../../src/main/monitor/parsers'

// 真实 Linux 样本（Ubuntu 22.04，4 核）
const PROC_STAT = `cpu  102914 1275 25908 2036892 3141 0 1729 0 0 0
cpu0 26011 331 6531 508519 800 0 452 0 0 0
cpu1 25703 315 6440 509911 761 0 419 0 0 0
cpu2 25806 310 6472 509241 796 0 431 0 0 0
cpu3 25393 318 6464 509219 783 0 426 0 0 0
intr 12345678 0 0
ctxt 34567890
btime 1750000000
processes 45678
procs_running 2
procs_blocked 0`

const MEMINFO = `MemTotal:        8039152 kB
MemFree:         4318996 kB
MemAvailable:    6842108 kB
Buffers:          143296 kB
Cached:          2560716 kB
SwapCached:            0 kB
Active:          1802336 kB
SReclaimable:     149188 kB
SwapTotal:       2097148 kB
SwapFree:        2097148 kB`

// busybox/Alpine 老内核：无 MemAvailable / SReclaimable
const MEMINFO_BUSYBOX = `MemTotal:         246116 kB
MemFree:           98304 kB
Buffers:            8192 kB
Cached:            40960 kB
SwapTotal:             0 kB
SwapFree:              0 kB`

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1234567    8901    0    0    0     0          0         0  1234567    8901    0    0    0     0       0          0
  eth0: 987654321  654321    0    0    0     0          0         0  123456789  234567    0    0    0     0       0          0
docker0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
  wlan0:  55555555   44444    0    0    0     0          0         0   6666666   33333    0    0    0     0       0          0`

const DISKSTATS = `   8       0 sda 12345 678 987654 4321 23456 789 1234567 8901 0 12345 13000
   8       1 sda1 12000 600 900000 4000 20000 700 1100000 8000 0 12000 12500
 259       0 nvme0n1 5000 100 400000 2000 8000 200 600000 3000 0 5000 5200
   7       0 loop0 100 0 800 10 0 0 0 0 0 10 10`

const DF = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         41020640 12594192  26310320      33% /
tmpfs              4019576        0   4019576       0% /dev/shm
/dev/sda2         98298648 93383712   4914936      96% /data
overlay           41020640 12594192  26310320      33% /var/lib/docker/overlay2/abc/merged
/dev/sdb1        103081248 51540624  51540624      50% /mnt/my volume`

describe('parseProcStat + diffCpuPct', () => {
  it('解析总量与每核', () => {
    const stat = parseProcStat(PROC_STAT)!
    expect(stat).not.toBeNull()
    expect(stat.cores).toHaveLength(4)
    // total = 全部字段之和
    expect(stat.all.total).toBe(102914 + 1275 + 25908 + 2036892 + 3141 + 0 + 1729)
    // idle = idle + iowait
    expect(stat.all.idle).toBe(2036892 + 3141)
  })

  it('两帧差分算使用率', () => {
    // 100 jiffies 增量里 25 是 idle → 75% 使用率
    expect(diffCpuPct({ total: 1000, idle: 500 }, { total: 1100, idle: 525 })).toBe(75)
    // 全空闲
    expect(diffCpuPct({ total: 1000, idle: 500 }, { total: 1100, idle: 600 })).toBe(0)
    // 满载
    expect(diffCpuPct({ total: 1000, idle: 500 }, { total: 1100, idle: 500 })).toBe(100)
  })

  it('无增量或计数器回绕时返回 0 而不是 NaN/负数', () => {
    expect(diffCpuPct({ total: 1000, idle: 500 }, { total: 1000, idle: 500 })).toBe(0)
    expect(diffCpuPct({ total: 1000, idle: 500 }, { total: 900, idle: 400 })).toBe(0)
  })

  it('非 Linux 输出返回 null 而不抛异常', () => {
    expect(parseProcStat('cat: /proc/stat: No such file or directory')).toBeNull()
    expect(parseProcStat('')).toBeNull()
  })
})

describe('parseMeminfo', () => {
  it('用 MemAvailable 算已用量', () => {
    const mem = parseMeminfo(MEMINFO)!
    expect(mem.totalKb).toBe(8039152)
    expect(mem.availableKb).toBe(6842108)
    expect(mem.usedKb).toBe(8039152 - 6842108)
    expect(mem.buffCacheKb).toBe(143296 + 2560716 + 149188)
    expect(mem.swapTotalKb).toBe(2097148)
    expect(mem.swapUsedKb).toBe(0)
  })

  it('老内核缺 MemAvailable 时退回 free + buff/cache', () => {
    const mem = parseMeminfo(MEMINFO_BUSYBOX)!
    expect(mem.availableKb).toBe(98304 + 8192 + 40960)
    expect(mem.usedKb).toBe(246116 - (98304 + 8192 + 40960))
    expect(mem.swapTotalKb).toBe(0)
  })

  it('无 MemTotal 返回 null', () => {
    expect(parseMeminfo('garbage')).toBeNull()
  })
})

describe('parseNetDev + diffRate', () => {
  it('跳过 lo 与虚拟网卡', () => {
    const list = parseNetDev(NET_DEV)
    expect(list.map((i) => i.iface)).toEqual(['eth0', 'wlan0'])
    expect(list[0].rxBytes).toBe(987654321)
    expect(list[0].txBytes).toBe(123456789)
  })

  it('includeAll 时保留全部网卡', () => {
    expect(parseNetDev(NET_DEV, true).map((i) => i.iface)).toEqual([
      'lo',
      'eth0',
      'docker0',
      'wlan0'
    ])
  })

  it('速率差分：回绕按 0，间隔为 0 按 0', () => {
    expect(diffRate(1000, 3000, 2)).toBe(1000)
    expect(diffRate(3000, 1000, 2)).toBe(0)
    expect(diffRate(1000, 3000, 0)).toBe(0)
  })
})

describe('parseDiskstats', () => {
  it('只统计整盘，忽略分区与 loop', () => {
    const disks = parseDiskstats(DISKSTATS)
    expect(disks.map((d) => d.dev)).toEqual(['sda', 'nvme0n1'])
    expect(disks[0].readSectors).toBe(987654)
    expect(disks[0].writeSectors).toBe(1234567)
  })
})

describe('parseDf', () => {
  it('跳过 tmpfs/overlay，解析容量与占用率', () => {
    const list = parseDf(DF)
    expect(list.map((f) => f.mount)).toEqual(['/', '/data', '/mnt/my volume'])
    expect(list[0].totalKb).toBe(41020640)
    expect(list[1].usePct).toBeCloseTo(95.0, 0)
  })

  it('挂载点含空格时完整保留', () => {
    expect(parseDf(DF).at(-1)!.mount).toBe('/mnt/my volume')
  })

  it('空输出与畸形行不抛异常', () => {
    expect(parseDf('')).toEqual([])
    expect(parseDf('Filesystem 1024-blocks\nbroken line')).toEqual([])
  })
})

describe('parseUptime / parseLoadAvg', () => {
  it('uptime 取整秒', () => {
    expect(parseUptime('123456.78 987654.32')).toBe(123456)
    expect(parseUptime('bad')).toBe(0)
  })

  it('loadavg 取前三个值', () => {
    expect(parseLoadAvg('0.52 0.31 0.24 1/234 5678')).toEqual([0.52, 0.31, 0.24])
    expect(parseLoadAvg('')).toEqual([0, 0, 0])
  })
})

describe('parseStaticInfo', () => {
  it('组合 uname / os-release / nproc / ip', () => {
    const info = parseStaticInfo({
      uname: 'Linux 5.15.0-91-generic x86_64',
      hostname: 'web-01\n',
      nproc: '4\n',
      osRelease: 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04.3 LTS"\nVERSION_ID="22.04"',
      ipAddr: '1: lo    inet 127.0.0.1/8 scope host lo\n2: eth0    inet 192.168.1.10/24 brd'
    })
    expect(info).toEqual({
      hostname: 'web-01',
      kernel: '5.15.0-91-generic',
      arch: 'x86_64',
      distro: 'Ubuntu 22.04.3 LTS',
      cpuCores: 4,
      ips: ['192.168.1.10']
    })
  })

  it('缺 os-release 时退回 uname，nproc 非法时至少 1 核', () => {
    const info = parseStaticInfo({
      uname: 'Linux 4.9.0 armv7l',
      hostname: 'router',
      nproc: '',
      osRelease: '',
      ipAddr: ''
    })
    expect(info.distro).toBe('Linux')
    expect(info.cpuCores).toBe(1)
    expect(info.ips).toEqual([])
  })
})

describe('parsePsTop', () => {
  it('解析进程列表并截断到 limit', () => {
    const text = `    PID %CPU %MEM COMMAND
   1234 45.2  3.1 node
   2345 12.0  1.5 nginx: worker process
   3456  1.0  0.2 sshd`
    const procs = parsePsTop(text, 2)
    expect(procs).toHaveLength(2)
    expect(procs[0]).toEqual({ pid: 1234, cpuPct: 45.2, memPct: 3.1, name: 'node' })
    expect(procs[1].name).toBe('nginx: worker process')
  })

  it('畸形输出返回空数组', () => {
    expect(parsePsTop('ps: command not found')).toEqual([])
  })
})

describe('parseSockstat', () => {
  // 真实样本：采集脚本一次 cat 了 sockstat 与 sockstat6，所以两份是拼接的
  const BOTH = `sockets: used 337
TCP: inuse 12 orphan 1 tw 3 alloc 20 mem 2
UDP: inuse 6 mem 3
UDPLITE: inuse 0
RAW: inuse 0
FRAG: inuse 0 memory 0
TCP6: inuse 4
UDP6: inuse 1
UDPLITE6: inuse 0
RAW6: inuse 0
FRAG6: inuse 0 memory 0`

  it('v4 与 v6 相加', () => {
    expect(parseSockstat(BOTH)).toEqual({
      socketsUsed: 337,
      tcpInuse: 16, // 12 + 4
      tcpOrphan: 1, // 只有 v4 那份有
      tcpTw: 3,
      udpInuse: 7 // 6 + 1
    })
  })

  it('关掉 IPv6（没有 sockstat6）时只算 v4，不报错', () => {
    const v4Only = `sockets: used 120
TCP: inuse 5 orphan 0 tw 0 alloc 8 mem 1
UDP: inuse 2 mem 0`
    expect(parseSockstat(v4Only)).toEqual({
      socketsUsed: 120,
      tcpInuse: 5,
      tcpOrphan: 0,
      tcpTw: 0,
      udpInuse: 2
    })
  })

  it('文件不存在 → null（非 Linux / 极简容器，按缺失容忍而不是当成 0）', () => {
    expect(parseSockstat('')).toBeNull()
    expect(parseSockstat('cat: /proc/net/sockstat: No such file or directory')).toBeNull()
  })

  it('全 0 也不是 null —— 有行就算采到了', () => {
    expect(parseSockstat('TCP: inuse 0 orphan 0 tw 0 alloc 0 mem 0')?.tcpInuse).toBe(0)
  })
})

describe('parseTcpStates', () => {
  it('映射十六进制状态码；顺序无关（awk 遍历哈希，顺序随机）', () => {
    expect(parseTcpStates('0A 9\n01 31\n06 3\n08 1')).toEqual({
      LISTEN: 9,
      ESTABLISHED: 31,
      TIME_WAIT: 3,
      CLOSE_WAIT: 1
    })
  })

  it('单字符状态码（awk 不补零）也认', () => {
    expect(parseTcpStates('1 4\n6 2')).toEqual({ ESTABLISHED: 4, TIME_WAIT: 2 })
  })

  it('认不出的状态码保留成 UNKNOWN_xx 而不是丢掉（丢掉会让总数对不上）', () => {
    expect(parseTcpStates('01 2\n1F 5')).toEqual({ ESTABLISHED: 2, UNKNOWN_1F: 5 })
  })

  it('awk 缺失 / 超时被杀 / 空输出 → 空对象，不抛', () => {
    expect(parseTcpStates('')).toEqual({})
    expect(parseTcpStates('sh: awk: command not found')).toEqual({})
    expect(parseTcpStates('Terminated')).toEqual({})
  })

  it('表头没被 FNR>1 跳掉的情况不会伪造出状态（st 不是十六进制数字对）', () => {
    expect(parseTcpStates('st 2\n01 7')).toEqual({ ESTABLISHED: 7 })
  })
})
