/**
 * SFTP 传输吞吐基准：流式 pipe vs ssh2 fastPut/fastGet。
 *
 * 背景：本项目为了支持暂停/取消，传输走 createReadStream→createWriteStream 顺序 pipe。
 * 顺序写在高延迟链路上受 RTT 制约（每块等一次 ACK），而 fastPut 用多请求并发填满管道。
 * 这个脚本给出两者的实测差距，作为是否引入"快速模式"的依据。
 *
 * 用法（凭据只从环境变量读）：
 *   $env:OFS_TEST_HOST=...; $env:OFS_TEST_PORT=...; $env:OFS_TEST_USER=...; $env:OFS_TEST_PASSWORD=...
 *   node scripts/benchSftp.mjs [MB]
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'

const { Client } = ssh2
const MB = Number(process.argv[2] ?? 20)
const CHUNK = 64 * 1024

const cfg = {
  host: process.env.OFS_TEST_HOST,
  port: Number(process.env.OFS_TEST_PORT ?? 22),
  username: process.env.OFS_TEST_USER ?? 'root',
  password: process.env.OFS_TEST_PASSWORD,
  readyTimeout: 20000,
  hostVerifier: () => true
}
if (!cfg.host || !cfg.password) {
  console.error('缺少 OFS_TEST_HOST / OFS_TEST_PASSWORD')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'ofs-bench-'))
const localSrc = join(dir, 'bench.bin')
const rate = (bytes, sec) => `${(bytes / 1024 / 1024 / sec).toFixed(2)} MB/s`

async function makeFile() {
  const chunk = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) % 256
  const fh = await fs.open(localSrc, 'w')
  try {
    for (let i = 0; i < MB; i++) await fh.write(chunk)
  } finally {
    await fh.close()
  }
  return (await fs.stat(localSrc)).size
}

function connect() {
  return new Promise((resolve, reject) => {
    const c = new Client()
    c.once('ready', () => resolve(c))
    c.once('error', reject)
    c.connect(cfg)
  })
}

function sftpOf(client) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
  })
}

/** 本项目当前的实现：顺序 pipe */
function uploadStreaming(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(localSrc, { highWaterMark: CHUNK })
    const ws = sftp.createWriteStream(remotePath, { flags: 'w' })
    rs.on('error', reject)
    ws.on('error', reject)
    ws.on('close', resolve)
    rs.pipe(ws)
  })
}

/** ssh2 的并发实现（默认 64 并发 × 32KB） */
function uploadFast(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localSrc, remotePath, {}, (err) => (err ? reject(err) : resolve()))
  })
}

function downloadStreaming(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    const rs = sftp.createReadStream(remotePath, { highWaterMark: CHUNK })
    const ws = createWriteStream(localPath)
    rs.on('error', reject)
    ws.on('error', reject)
    ws.on('finish', resolve)
    rs.pipe(ws)
  })
}

function downloadFast(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, {}, (err) => (err ? reject(err) : resolve()))
  })
}

function unlink(sftp, path) {
  return new Promise((resolve) => sftp.unlink(path, () => resolve()))
}

async function timed(label, fn) {
  const t = Date.now()
  await fn()
  const sec = (Date.now() - t) / 1000
  console.log(`${label.padEnd(22)} ${sec.toFixed(1)}s  ${rate(MB * 1024 * 1024, sec)}`)
  return sec
}

const results = {}
const client = await connect()
try {
  const size = await makeFile()
  console.log(`文件 ${MB}MB (${size} 字节)，chunk ${CHUNK / 1024}KB\n`)
  const sftp = await sftpOf(client)
  const remoteA = `/tmp/ofs-bench-stream-${Date.now()}.bin`
  const remoteB = `/tmp/ofs-bench-fast-${Date.now()}.bin`

  results.uploadStreaming = await timed('上传 · 顺序流式', () => uploadStreaming(sftp, remoteA))
  results.uploadFast = await timed('上传 · fastPut 并发', () => uploadFast(sftp, remoteB))
  results.downloadStreaming = await timed('下载 · 顺序流式', () =>
    downloadStreaming(sftp, remoteB, join(dir, 'back-stream.bin'))
  )
  results.downloadFast = await timed('下载 · fastGet 并发', () =>
    downloadFast(sftp, remoteB, join(dir, 'back-fast.bin'))
  )

  await unlink(sftp, remoteA)
  await unlink(sftp, remoteB)

  console.log('\n倍数差距：')
  console.log(`  上传 fastPut / 流式 = ${(results.uploadStreaming / results.uploadFast).toFixed(1)}x`)
  console.log(`  下载 fastGet / 流式 = ${(results.downloadStreaming / results.downloadFast).toFixed(1)}x`)
} finally {
  client.end()
  rmSync(dir, { recursive: true, force: true })
}
