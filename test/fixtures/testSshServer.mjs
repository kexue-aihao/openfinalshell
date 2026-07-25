/**
 * 本地测试 SSH 服务器（基于 ssh2 的 Server）。
 * 用于在没有真实 Linux 主机的环境下验证：认证 → shell 通道 → 数据往返 → 背压。
 *
 * 用法：node test/fixtures/testSshServer.mjs [port]
 *   账号 test / 密码 test123
 *   支持 password 与 keyboard-interactive 两种认证（后者用于验证 kbi 流程）
 *   shell 是一个极简的回显 REPL，另支持 `flood <n>` 输出 n MB 数据以压测背压。
 */
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'

const { Server } = ssh2
const port = Number(process.argv[2] ?? 2222)

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

server.listen(port, '127.0.0.1', () => {
  console.log(`[srv] test ssh server listening on 127.0.0.1:${port}`)
  console.log('[srv]   password auth:  test / test123')
  console.log('[srv]   kbi auth:       kbi  / test123')
})
