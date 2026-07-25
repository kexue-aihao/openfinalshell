/**
 * 端到端冒烟：用与 main 进程相同的 ssh2 调用路径连测试服务器，
 * 验证 认证 → shell → 数据往返(UTF-8/emoji) → pty size → flood 背压（pause/resume 不丢数据）。
 *
 * 前置：node test/fixtures/testSshServer.mjs 2222
 * 用法：node test/fixtures/smokeSsh.mjs
 */
import ssh2 from 'ssh2'
const { Client } = ssh2

const FLOOD_MB = 8
const client = new Client()

/** 阶段状态机：flood 阶段只统计字节数，不做字符串累积（否则 includes 是 O(n²)） */
let phase = 'prompt'
let buf = ''
let flooded = 0
let pausedOnce = false

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}
const timeout = setTimeout(() => fail('timeout'), 60000)

client
  .on('ready', () => {
    console.log('OK auth ready')
    client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err, stream) => {
      if (err) fail(`shell: ${err.message}`)

      stream.on('data', (chunk) => {
        if (phase === 'flood') {
          flooded += chunk.length
          // 只在尾部小窗口里找结束标记，避免大字符串扫描
          const tail = chunk.toString('utf8')
          if (tail.includes(`[done ${FLOOD_MB}MB]`)) {
            clearTimeout(timeout)
            const mb = flooded / 1024 / 1024
            console.log(`OK flood ~${mb.toFixed(1)}MB received (backpressure exercised=${pausedOnce})`)
            if (mb < FLOOD_MB * 0.9) fail(`flood data loss (${mb.toFixed(1)}MB < ${FLOOD_MB}MB)`)
            console.log('ALL PASS')
            client.end()
            process.exit(0)
          }
          return
        }

        buf += chunk.toString('utf8')
        if (phase === 'prompt' && buf.includes('test@fixture:~$ ')) {
          phase = 'echo'
          buf = ''
          stream.write('echo hello-中文-🚀\r')
        } else if (phase === 'echo' && buf.includes('hello-中文-🚀\r\n')) {
          console.log('OK echo roundtrip (utf8 + emoji)')
          phase = 'size'
          buf = ''
          stream.write('size\r')
        } else if (phase === 'size' && buf.includes('100x30')) {
          console.log('OK pty size 100x30')
          phase = 'flood'
          buf = ''
          flooded = 0
          stream.write(`flood ${FLOOD_MB}\r`)
          // 模拟 renderer 消费慢：周期性 pause/resume，验证背压期间不丢数据
          const iv = setInterval(() => {
            if (!stream.isPaused()) {
              stream.pause()
              pausedOnce = true
              setTimeout(() => stream.resume(), 20)
            }
          }, 50)
          setTimeout(() => clearInterval(iv), 30000)
        }
      })
    })
  })
  .on('error', (err) => fail(`connect: ${err.message}`))
  .connect({
    host: '127.0.0.1',
    port: 2222,
    username: 'test',
    password: 'test123',
    readyTimeout: 10000,
    hostVerifier: () => true
  })
