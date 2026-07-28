/**
 * 本地测试 SSH 服务器（基于 ssh2 的 Server）。
 * 用于在没有真实 Linux 主机的环境下验证：认证 → shell 通道 → 数据往返 → 背压 → SFTP。
 *
 * 用法：node test/fixtures/testSshServer.mjs [port] [sftpRoot]
 *   账号 test / 密码 test123
 *   支持 password 与 keyboard-interactive 两种认证（后者用于验证 kbi 流程）
 *   shell 是一个极简的回显 REPL，另支持 `flood <n>` 输出 n MB 数据以压测背压。
 *   SFTP 子系统把请求映射到本地 sftpRoot 目录（默认系统临时目录下新建一个）。
 */
import { generateKeyPairSync } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const { STATUS_CODE: SFTP_STATUS_CODE, OPEN_MODE: SFTP_OPEN_MODE } = utils.sftp
const port = Number(process.argv[2] ?? 2222)
const sftpRoot = process.argv[3] ?? mkdtempSync(path.join(tmpdir(), 'ofs-sftp-root-'))

/**
 * 每条连接允许同时存在的 session 通道数上限，0 = 不限。对应 sshd 的 `MaxSessions`。
 *
 * 为什么要有它：本项目一条会话常驻 N 个 shell + 1 个浏览 SFTP + 1 个监控 exec，
 * 而把 MaxSessions 调成 2 的低配服务器不少见。"通道开不出来时给的是人能懂的话
 * 还是 ssh2 的原话"这件事以前只能靠找一台那样的服务器手工验 ——
 * 于是它就一直躺在待办里没人验。封顶放在 fixture 里，这条就能自动跑。
 *
 * 用环境变量而不是第 4 个位置参数：位置参数会逼着调用方先给出 sftpRoot，
 * 而绝大多数调用方并不关心它。
 */
const maxSessions = Number(process.env.OFS_FIXTURE_MAX_SESSIONS ?? '0') || 0

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
})

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  console.log('[srv] client connected')

  client
    .on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test123') {
        return ctx.accept()
      }
      if (ctx.method === 'keyboard-interactive' && ctx.username === 'kbi') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) =>
          answers[0] === 'test123' ? ctx.accept() : ctx.reject()
        )
      }
      if (ctx.method === 'none') {
        return ctx.reject(['password', 'keyboard-interactive'])
      }
      ctx.reject()
    })
    .on('ready', () => {
      console.log('[srv] authenticated')

      // -L / dynamic：客户端请求连到某个目标，这里真的用本地 socket 去连
      client.on('tcpip', (accept, reject, info) => {
        const target = net.connect(info.destPort, info.destIP, () => {
          const channel = accept()
          channel.pipe(target).pipe(channel)
          const destroyBoth = () => {
            target.destroy()
            channel.close()
          }
          channel.on('close', destroyBoth)
          channel.on('error', destroyBoth)
          target.on('error', destroyBoth)
        })
        target.on('error', () => reject())
      })

      // -R：客户端请求服务器监听端口；这里起一个真实的 net server，
      // 每个入站连接经 forwardOut 回推给客户端
      const remoteListeners = new Map()
      client.on('request', (acceptReq, rejectReq, name, info) => {
        if (name === 'tcpip-forward') {
          const server = net.createServer((socket) => {
            client.forwardOut(
              info.bindAddr,
              info.bindPort,
              socket.remoteAddress ?? '127.0.0.1',
              socket.remotePort ?? 0,
              (err, channel) => {
                if (err) return socket.destroy()
                socket.pipe(channel).pipe(socket)
              }
            )
          })
          server.listen(info.bindPort, info.bindAddr === '' ? '127.0.0.1' : info.bindAddr, () => {
            const port = server.address().port
            remoteListeners.set(`${info.bindAddr}:${port}`, server)
            // bindPort=0 时协议要求回报实际端口
            acceptReq?.(port)
          })
          server.on('error', () => rejectReq?.())
          return
        }
        if (name === 'cancel-tcpip-forward') {
          const key = `${info.bindAddr}:${info.bindPort}`
          remoteListeners.get(key)?.close()
          remoteListeners.delete(key)
          acceptReq?.()
          return
        }
        rejectReq?.()
      })
      client.on('close', () => {
        for (const server of remoteListeners.values()) server.close()
        remoteListeners.clear()
      })

      // 只数**同时存活**的通道，关掉一个就腾出一格 —— sshd 的 MaxSessions 就是这个语义
      let liveSessions = 0
      client.on('session', (accept, reject) => {
        if (maxSessions > 0 && liveSessions >= maxSessions) {
          console.log(`[srv] 拒绝 session 通道：已有 ${liveSessions} 个，上限 ${maxSessions}`)
          reject?.()
          return
        }
        liveSessions += 1
        const session = accept()
        session.once('close', () => {
          liveSessions = Math.max(0, liveSessions - 1)
        })
        let ptyInfo = { cols: 80, rows: 24 }

        session.on('pty', (acceptPty, _reject, info) => {
          ptyInfo = info
          acceptPty?.()
        })
        session.on('window-change', (acceptWc, _reject, info) => {
          ptyInfo = info
          console.log(`[srv] window-change ${info.cols}x${info.rows}`)
          acceptWc?.()
        })

        session.on('sftp', (acceptSftp) => {
          attachSftp(acceptSftp())
        })

        /*
         * exec 三种形态：
         *  - `env … sh -c <脚本>`：ExecRunner 的一次性命令。**必须排在裸 sh 前面判** ——
         *    只按 /\bsh\b/ 判会把它误当成读 stdin 的常驻通道，于是调用方永远等不到应答、
         *    只能等帧超时，而故障现场看起来像"网络慢"。
         *  - 裸 `sh`：监控采集用的常驻通道（读 stdin 逐行执行）。
         *  - 别的：监控静态帧里那些单条命令。
         *
         * 一次性命令这条只当**镜子**：把收到的命令原样回显，让测试能断言"发出去的字节
         * 经过 ssh2 的 exec 一字未变"。这个 fixture 没有真文件系统也没有真 shell，
         * 所以 rm 的真实语义在它上面**无法**被验证 —— 那些归真机验收。
         */
        session.on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec()
          if (/\s-c\s/.test(info.command)) {
            stream.write(`@@FIXTURE:EXEC@@\n${info.command}\n@@FIXTURE:END@@\n`)
            stream.exit(0)
            stream.end()
          } else if (/\bsh\b/.test(info.command)) {
            attachFakeShell(stream)
          } else {
            stream.write(runFakeCommand(info.command))
            stream.exit(0)
            stream.end()
          }
        })

        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          /**
           * 提示符可切换 —— `ps1 exotic` / `ps1 default`。
           *
           * 这不是玩票：命令历史的采集有两条路，主路是"这一行第一个键按下时光标在第几列"，
           * 退路是认 `$ ` / `# ` / `% `。默认这个提示符**两条路都能走通**，
           * 于是冒烟里主路坏掉了也照样绿（退路兜住了）。
           * exotic 那个提示符里没有任何一个退路认得的符号，
           * 所以它一响，主路就是唯一能把命令切出来的东西。
           */
          const PROMPTS = { default: 'test@fixture:~$ ', exotic: '➜  ~ ' }
          let ps1 = PROMPTS.default
          const prompt = () => stream.write(ps1)
          stream.write(`欢迎使用测试 SSH 服务器 (${ptyInfo.cols}x${ptyInfo.rows})\r\n`)
          stream.write('可用命令: echo <文本> / flood <MB> / size / ps1 <default|exotic> / exit\r\n')
          prompt()

          let line = ''
          stream.on('data', (chunk) => {
            const s = chunk.toString('utf8')
            for (const ch of s) {
              if (ch === '\r' || ch === '\n') {
                stream.write('\r\n')
                handle(line.trim())
                line = ''
              } else if (ch === '\x7f' || ch === '\b') {
                if (line.length > 0) {
                  line = line.slice(0, -1)
                  stream.write('\b \b')
                }
              } else if (ch === '\x03') {
                stream.write('^C\r\n')
                line = ''
                prompt()
              } else {
                line += ch
                stream.write(ch) // 回显
              }
            }
          })

          function handle(cmd) {
            if (cmd === '') return prompt()
            if (cmd === 'exit') return stream.exit(0), stream.end()
            if (cmd === 'size') {
              stream.write(`${ptyInfo.cols}x${ptyInfo.rows}\r\n`)
              return prompt()
            }
            if (cmd.startsWith('echo ')) {
              stream.write(`${cmd.slice(5)}\r\n`)
              return prompt()
            }
            const ps1cmd = /^ps1\s+(default|exotic)$/.exec(cmd)
            if (ps1cmd) {
              ps1 = PROMPTS[ps1cmd[1]]
              stream.write(`prompt -> ${ps1cmd[1]}\r\n`)
              return prompt()
            }
            const flood = /^flood\s+(\d+)$/.exec(cmd)
            if (flood) {
              const mb = Math.min(Number(flood[1]), 512)
              const chunk = `${'x'.repeat(1023)}\n`
              const perMb = 1024
              let written = 0
              const pump = () => {
                while (written < mb * perMb) {
                  written++
                  if (!stream.write(chunk)) {
                    stream.once('drain', pump)
                    return
                  }
                }
                stream.write(`\r\n[done ${mb}MB]\r\n`)
                prompt()
              }
              pump()
              return
            }
            stream.write(`sh: ${cmd}: command not found\r\n`)
            prompt()
          }
        })
      })
    })
    .on('error', (err) => console.log(`[srv] client error: ${err.message}`))
    .on('close', () => console.log('[srv] client disconnected'))
})

// ---------------------------------------------------------------------------
// 假 Linux 环境：为监控采集提供 /proc 风格输出。
// 计数器每次读取都递增，使客户端的两帧差分能算出非零速率。
// ---------------------------------------------------------------------------
let counterTick = 0

function fakeProcStat() {
  counterTick += 1
  // 每 tick：总量 +400，其中 idle +100 → 稳定 75% 使用率
  const base = 100000 + counterTick * 300
  const idle = 500000 + counterTick * 100
  const perCore = (i) =>
    `cpu${i} ${Math.floor(base / 4)} 300 ${Math.floor(base / 8)} ${Math.floor(idle / 4)} 100 0 50 0 0 0`
  return [
    `cpu  ${base} 1200 ${Math.floor(base / 2)} ${idle} 400 0 200 0 0 0`,
    perCore(0),
    perCore(1),
    'intr 12345',
    'ctxt 67890',
    'btime 1750000000',
    'processes 4567',
    'procs_running 2',
    'procs_blocked 0'
  ].join('\n')
}

function fakeMeminfo() {
  return [
    'MemTotal:        8039152 kB',
    'MemFree:         4318996 kB',
    'MemAvailable:    6842108 kB',
    'Buffers:          143296 kB',
    'Cached:          2560716 kB',
    'SReclaimable:     149188 kB',
    'SwapTotal:       2097148 kB',
    'SwapFree:        2000000 kB'
  ].join('\n')
}

function fakeNetDev() {
  // 每 tick 收发各 +1MB
  const rx = 1_000_000 + counterTick * 1_048_576
  const tx = 500_000 + counterTick * 524_288
  return [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    `    lo: 5000 50 0 0 0 0 0 0 5000 50 0 0 0 0 0 0`,
    `  eth0: ${rx} 1000 0 0 0 0 0 0 ${tx} 900 0 0 0 0 0 0`
  ].join('\n')
}

function fakeDiskstats() {
  const read = 900000 + counterTick * 2048
  const write = 1200000 + counterTick * 4096
  return [
    `   8       0 sda 12345 678 ${read} 4321 23456 789 ${write} 8901 0 12345 13000`,
    `   8       1 sda1 12000 600 800000 4000 20000 700 1000000 8000 0 12000 12500`
  ].join('\n')
}

const FAKE_DF = [
  'Filesystem     1024-blocks     Used Available Capacity Mounted on',
  '/dev/sda1         41020640 12594192  26310320      33% /',
  'tmpfs              4019576        0   4019576       0% /dev/shm',
  '/dev/sda2         98298648 93383712   4914936      96% /data'
].join('\n')

/** /proc/net/sockstat 与 sockstat6 拼在一起（采集脚本一次 cat 两个文件） */
const FAKE_SOCKSTAT = [
  'sockets: used 337',
  'TCP: inuse 12 orphan 0 tw 3 alloc 20 mem 2',
  'UDP: inuse 6 mem 3',
  'UDPLITE: inuse 0',
  'RAW: inuse 0',
  'FRAG: inuse 0 memory 0',
  'TCP6: inuse 4',
  'UDP6: inuse 1',
  'UDPLITE6: inuse 0',
  'RAW6: inuse 0',
  'FRAG6: inuse 0 memory 0'
].join('\n')

/** 服务器侧 awk 聚合后的形态：`<十六进制状态> <数量>`，顺序随机（awk 遍历哈希） */
const FAKE_TCP_STATES = ['0A 9', '01 31', '06 3', '08 1'].join('\n')

const FAKE_PS = [
  '    PID %CPU %MEM COMMAND',
  '   1234 45.2  3.1 node',
  '   2345 12.0  1.5 nginx',
  '   3456  1.0  0.2 sshd'
].join('\n')

const FAKE_OS_RELEASE = [
  'NAME="Ubuntu"',
  'VERSION="22.04.3 LTS (Jammy Jellyfish)"',
  'PRETTY_NAME="Ubuntu 22.04.3 LTS"',
  'VERSION_ID="22.04"'
].join('\n')

/** 支持监控脚本用到的少量命令；未知命令输出空（模拟 2>/dev/null） */
function runFakeCommand(cmd) {
  const c = cmd.trim()
  if (/^echo\s+/.test(c)) {
    return `${c.replace(/^echo\s+/, '').replace(/^"(.*)"$/, '$1')}\n`
  }
  if (c.includes('/proc/stat')) return `${fakeProcStat()}\n`
  if (c.includes('/proc/meminfo')) return `${fakeMeminfo()}\n`
  if (c.includes('/proc/net/dev')) return `${fakeNetDev()}\n`
  if (c.includes('/proc/diskstats')) return `${fakeDiskstats()}\n`
  if (c.includes('/proc/net/sockstat')) return `${FAKE_SOCKSTAT}\n`
  // TCPST 段：`[timeout 3 ]awk '…' /proc/net/tcp /proc/net/tcp6`
  if (c.includes('/proc/net/tcp')) return `${FAKE_TCP_STATES}\n`
  if (c.includes('/proc/uptime')) return `${123456 + counterTick}.78 987654.32\n`
  if (c.includes('/proc/loadavg')) return '0.52 0.31 0.24 2/345 6789\n'
  if (/\bdf\b/.test(c)) return `${FAKE_DF}\n`
  if (/^ps\b/.test(c) || c.includes('| head -n 9')) return `${FAKE_PS}\n`
  if (/^uname/.test(c)) return 'Linux 5.15.0-91-generic x86_64\n'
  if (/^hostname/.test(c) || c.includes('kernel/hostname')) return 'fixture-host\n'
  if (/^nproc/.test(c) || c.includes('^processor')) return '2\n'
  if (c.includes('/etc/os-release')) return `${FAKE_OS_RELEASE}\n`
  if (/^ip\b/.test(c) || /^ifconfig/.test(c)) {
    return '1: lo    inet 127.0.0.1/8 scope host lo\n2: eth0    inet 10.0.0.5/24 brd 10.0.0.255\n'
  }
  if (c.includes('command -v timeout')) return 'yes\n'
  return ''
}

/**
 * 假 sh：读 stdin 的每一行当命令执行。
 * 与真实 `sh` 的关键行为一致 —— 无回显、无提示符、按行顺序输出。
 */
function attachFakeShell(stream) {
  let pending = ''
  stream.on('data', (chunk) => {
    pending += chunk.toString('utf8')
    let idx
    while ((idx = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, idx)
      pending = pending.slice(idx + 1)
      if (line.trim()) stream.write(runFakeCommand(line))
    }
  })
  stream.on('end', () => {
    stream.exit(0)
    stream.end()
  })
}

/**
 * 极简 SFTP 子系统：把远端 POSIX 路径映射到本地 sftpRoot 下。
 * 只实现客户端会用到的操作，够验证传输管线；不做权限模拟。
 */
function attachSftp(sftp) {
  /** 句柄表：4 字节整数 handle → { fd, path } 或 { dirEntries, offset } */
  const handles = new Map()
  let nextHandle = 1
  const makeHandle = (value) => {
    const id = nextHandle++
    handles.set(id, value)
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(id, 0)
    return buf
  }
  const readHandle = (buf) => handles.get(buf.readUInt32BE(0))

  /** 远端路径 → 本地路径（拒绝越出 sftpRoot） */
  const local = (remote) => {
    const normalized = path.posix.normalize(remote.replace(/\\/g, '/'))
    const rel = normalized.replace(/^\/+/, '')
    const abs = path.resolve(sftpRoot, rel)
    if (!abs.startsWith(sftpRoot)) throw new Error('path escapes root')
    return abs
  }

  const statusFromError = (err) => {
    if (!err) return SFTP_STATUS_CODE.OK
    if (err.code === 'ENOENT') return SFTP_STATUS_CODE.NO_SUCH_FILE
    if (err.code === 'EACCES' || err.code === 'EPERM') return SFTP_STATUS_CODE.PERMISSION_DENIED
    return SFTP_STATUS_CODE.FAILURE
  }

  const toAttrs = (st) => ({
    mode: st.mode,
    uid: 0,
    gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  })

  const longname = (name, st) => {
    const dir = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-'
    const perm = (st.mode & 0o777).toString(8).padStart(3, '0')
    return `${dir}rwxr-xr-x 1 test test ${String(st.size).padStart(8)} Jan  1 00:00 ${name} (${perm})`
  }

  sftp.on('REALPATH', (reqid, givenPath) => {
    try {
      const target = givenPath === '.' || givenPath === '' ? '/' : path.posix.normalize(givenPath)
      const st = fs.statSync(local(target))
      sftp.name(reqid, [{ filename: target, longname: longname(target, st), attrs: toAttrs(st) }])
    } catch {
      sftp.name(reqid, [{ filename: '/', longname: 'd--------- 1 test test 0 Jan 1 00:00 /', attrs: {} }])
    }
  })

  sftp.on('STAT', (reqid, p) => handleStat(reqid, p, false))
  sftp.on('LSTAT', (reqid, p) => handleStat(reqid, p, true))
  function handleStat(reqid, p, useLstat) {
    try {
      const st = useLstat ? fs.lstatSync(local(p)) : fs.statSync(local(p))
      sftp.attrs(reqid, toAttrs(st))
    } catch (err) {
      sftp.status(reqid, statusFromError(err))
    }
  }

  sftp.on('OPENDIR', (reqid, p) => {
    try {
      const abs = local(p)
      const names = fs.readdirSync(abs)
      const entries = names.map((name) => {
        const st = fs.lstatSync(path.join(abs, name))
        return { filename: name, longname: longname(name, st), attrs: toAttrs(st) }
      })
      sftp.handle(reqid, makeHandle({ entries, offset: 0 }))
    } catch (err) {
      sftp.status(reqid, statusFromError(err))
    }
  })

  sftp.on('READDIR', (reqid, handleBuf) => {
    const h = readHandle(handleBuf)
    if (!h?.entries) return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE)
    if (h.offset >= h.entries.length) return sftp.status(reqid, SFTP_STATUS_CODE.EOF)
    const chunk = h.entries.slice(h.offset, h.offset + 50)
    h.offset += chunk.length
    sftp.name(reqid, chunk)
  })

  sftp.on('OPEN', (reqid, filename, flags) => {
    try {
      let mode = 'r'
      if (flags & SFTP_OPEN_MODE.APPEND) mode = 'a'
      else if (flags & SFTP_OPEN_MODE.TRUNC || flags & SFTP_OPEN_MODE.CREAT) mode = 'w'
      if (flags & SFTP_OPEN_MODE.WRITE && mode === 'r') mode = 'r+'
      const fd = fs.openSync(local(filename), mode)
      sftp.handle(reqid, makeHandle({ fd }))
    } catch (err) {
      sftp.status(reqid, statusFromError(err))
    }
  })

  sftp.on('READ', (reqid, handleBuf, offset, length) => {
    const h = readHandle(handleBuf)
    if (h?.fd === undefined) return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE)
    const buf = Buffer.alloc(length)
    try {
      const bytes = fs.readSync(h.fd, buf, 0, length, offset)
      if (bytes === 0) return sftp.status(reqid, SFTP_STATUS_CODE.EOF)
      sftp.data(reqid, buf.subarray(0, bytes))
    } catch (err) {
      sftp.status(reqid, statusFromError(err))
    }
  })

  sftp.on('WRITE', (reqid, handleBuf, offset, data) => {
    const h = readHandle(handleBuf)
    if (h?.fd === undefined) return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE)
    try {
      fs.writeSync(h.fd, data, 0, data.length, offset)
      sftp.status(reqid, SFTP_STATUS_CODE.OK)
    } catch (err) {
      sftp.status(reqid, statusFromError(err))
    }
  })

  sftp.on('CLOSE', (reqid, handleBuf) => {
    const id = handleBuf.readUInt32BE(0)
    const h = handles.get(id)
    if (h?.fd !== undefined) {
      try {
        fs.closeSync(h.fd)
      } catch {
        /* ignore */
      }
    }
    handles.delete(id)
    sftp.status(reqid, SFTP_STATUS_CODE.OK)
  })

  sftp.on('MKDIR', (reqid, p) => simple(reqid, () => fs.mkdirSync(local(p))))
  sftp.on('RMDIR', (reqid, p) => simple(reqid, () => fs.rmdirSync(local(p))))
  sftp.on('REMOVE', (reqid, p) => simple(reqid, () => fs.unlinkSync(local(p))))
  sftp.on('RENAME', (reqid, from, to) => simple(reqid, () => fs.renameSync(local(from), local(to))))
  sftp.on('SETSTAT', (reqid, p, attrs) =>
    simple(reqid, () => {
      if (attrs.mode !== undefined) fs.chmodSync(local(p), attrs.mode & 0o7777)
    })
  )
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, SFTP_STATUS_CODE.OK))
  sftp.on('READLINK', (reqid, p) => {
    try {
      const target = fs.readlinkSync(local(p))
      sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }])
    } catch (err) {
      sftp.status(reqid, statusFromError(err))
    }
  })

  function simple(reqid, fn) {
    try {
      fn()
      sftp.status(reqid, SFTP_STATUS_CODE.OK)
    } catch (err) {
      sftp.status(reqid, statusFromError(err))
    }
  }

  void fsConstants
}

server.listen(port, '127.0.0.1', () => {
  console.log(`[srv] test ssh server listening on 127.0.0.1:${port}`)
  console.log('[srv]   password auth:  test / test123')
  console.log('[srv]   kbi auth:       kbi  / test123')
  console.log(`[srv]   sftp root:      ${sftpRoot}`)
})
