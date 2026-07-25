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
import { tmpdir } from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const { STATUS_CODE: SFTP_STATUS_CODE, OPEN_MODE: SFTP_OPEN_MODE } = utils.sftp
const port = Number(process.argv[2] ?? 2222)
const sftpRoot = process.argv[3] ?? mkdtempSync(path.join(tmpdir(), 'ofs-sftp-root-'))

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
      client.on('session', (accept) => {
        const session = accept()
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

        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          const prompt = () => stream.write('test@fixture:~$ ')
          stream.write(`欢迎使用测试 SSH 服务器 (${ptyInfo.cols}x${ptyInfo.rows})\r\n`)
          stream.write('可用命令: echo <文本> / flood <MB> / size / exit\r\n')
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
