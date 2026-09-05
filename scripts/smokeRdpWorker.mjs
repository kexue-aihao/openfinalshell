import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { RdpSmokeLedger, validateAcceptedRdpSmokeExit } from './rdpSmokeLedger.mjs'

const MAX_PAYLOAD = 64 * 1024 * 1024
const HEADER_SIZE = 16
const worker = resolve(process.argv[2] ?? join('build', 'rdp-worker', process.platform === 'win32' ? 'ofs-rdp-worker.exe' : 'ofs-rdp-worker'))

function requiredEnv(name) {
  return process.env[name]?.trim() || ''
}

function numberEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a TCP port`)
  return value
}

function truthy(value) {
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'on' || value === 'ON' || value === 'yes'
}

function frame(type, requestId, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(HEADER_SIZE)
  header.write('OFSR', 0, 'ascii')
  header.writeUInt16LE(1, 4)
  header.writeUInt8(type, 6)
  header.writeUInt32LE(data.length, 8)
  header.writeUInt32LE(requestId, 12)
  return Buffer.concat([header, data])
}

function parseFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + HEADER_SIZE <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OFSR') throw new Error('worker emitted a non-OFSR frame')
    if (buffer.readUInt16LE(offset + 4) !== 1 || buffer.readUInt8(offset + 7) !== 0) throw new Error('worker emitted an incompatible frame header')
    const length = buffer.readUInt32LE(offset + 8)
    if (length > MAX_PAYLOAD) throw new Error('worker emitted an oversized frame')
    if (offset + HEADER_SIZE + length > buffer.length) break
    const type = buffer.readUInt8(offset + 6)
    const requestId = buffer.readUInt32LE(offset + 12)
    const payload = buffer.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length)
    frames.push({
      type,
      requestId,
      payload,
      json: type === 0x30 ? null : JSON.parse(payload.toString('utf8'))
    })
    offset += HEADER_SIZE + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

function selfTestHello() {
  const env = isolatedEnv(dirname(worker))
  const result = spawnSync(worker, ['--self-test'], {
    env,
    maxBuffer: 1024 * 1024,
    shell: false
  })
  cleanupSmokeHome(env)
  if (result.error) throw result.error
  assert.equal(result.status, 0, `worker self-test failed: ${result.stderr.toString('utf8')}`)
  const { frames, rest } = parseFrames(result.stdout)
  assert.equal(rest.length, 0, 'self-test emits complete frames')
  assert.equal(frames.length, 1, 'self-test emits one HELLO')
  assert.equal(frames[0].json.workerVersion, 'freerdp', 'real RDP smoke requires a FreeRDP backend build')
  assert.ok(frames[0].json.capabilities.includes('freerdp'), 'FreeRDP capability is advertised')
  assert.ok(!frames[0].json.capabilities.includes('mock'), 'mock capability is not advertised')
}

function isolatedEnv(workerDir) {
  const root = mkdtempSync(join(tmpdir(), 'ofs-rdp-smoke-'))
  const appData = join(root, 'AppData', 'Roaming')
  const localAppData = join(root, 'AppData', 'Local')
  mkdirSync(appData, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const path = process.platform === 'win32'
    ? [workerDir, systemRoot, join(systemRoot, 'System32'), process.env.PATH ?? ''].join(';')
    : process.env.PATH
  return {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    USERPROFILE: root,
    HOME: root,
    PATH: path,
    OFS_RDP_SMOKE_HOME: root
  }
}

function cleanupSmokeHome(env) {
  const root = env.OFS_RDP_SMOKE_HOME
  if (!root) return
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Some FreeRDP builds briefly retain file handles after process exit.
  }
}

function startPayload(config) {
  return {
    op: 'start',
    host: config.host,
    port: config.port,
    username: config.username,
    domain: config.domain,
    gateway: null,
    display: { width: 640, height: 480, dpi: 96 },
    features: { clipboard: true, certificatePolicy: 'prompt' }
  }
}

function runScenario(name, config) {
  return new Promise((resolve, reject) => {
    const env = isolatedEnv(dirname(worker))
    const child = spawn(worker, [], { env, stdio: 'pipe', windowsHide: true, shell: false })
    let buffer = Buffer.alloc(0)
    let requestId = 1
    let hello = false
    let credentialSent = false
    let promptSeen = false
    let frameSeen = false
    let ready = false
    let closeSent = false
    let closed = false
    let controlsSent = false
    let certificateRejectionObserved = false
    let settled = false
    let stderr = ''
    const ledger = new RdpSmokeLedger()
    const timer = setTimeout(() => finish(new Error(`${name} timed out`)), config.timeoutMs)
    timer.unref()

    const write = (type, payload, fixedRequestId, expectation) => {
      const id = fixedRequestId ?? requestId++
      if (expectation) ledger.register(id, expectation.name, expectation.response)
      child.stdin.write(frame(type, id, payload))
      return id
    }

    const maybeClose = () => {
      if (!controlsSent || closeSent || ledger.pendingCount !== 0) return
      closeSent = true
      write(0x12, { op: 'close', reason: 'user' }, undefined, { name: 'close', response: 'state:closed' })
    }

    const finish = (error, result = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (!child.killed) child.kill()
      } catch {
        // Process may already be gone.
      }
      cleanupSmokeHome(env)
      if (error) reject(error)
      else resolve({ promptSeen, frameSeen, ready, ...result })
    }

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })

    child.stdout.on('data', (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk])
        const parsed = parseFrames(buffer)
        buffer = parsed.rest
        for (const entry of parsed.frames) {
          if (entry.type === 0x01) {
            assert.equal(entry.requestId, 0, 'HELLO has request id 0')
            assert.equal(entry.json.workerVersion, 'freerdp', 'worker advertises FreeRDP')
            assert.ok(!entry.json.capabilities.includes('mock'), 'worker does not advertise mock')
            hello = true
            write(0x02, { op: 'helloAck', protocol: 1, maxPayload: MAX_PAYLOAD, sessionId: `smoke-${name}` }, 0)
            write(0x10, startPayload(config), undefined, { name: 'start', response: 'state:connecting' })
            write(0x11, { op: 'credential', kind: 'password', value: config.password }, undefined, { name: 'credential', response: 'ack' })
            credentialSent = true
          } else if (entry.type === 0x21) {
            assert.equal(entry.json.kind, 'certificate', 'only certificate prompts are expected')
            promptSeen = true
            if (!config.acceptCertificate) {
              write(0x11, { op: 'certificate', requestId: entry.requestId, accept: false }, entry.requestId)
            } else {
              write(0x11, { op: 'certificate', requestId: entry.requestId, accept: true }, entry.requestId,
                { name: 'certificate', response: 'ack' })
            }
          } else if (entry.type === 0x30) {
            frameSeen = true
          } else if (entry.type === 0x20 && entry.json.op === 'state') {
            if (entry.json.state === 'ready') {
              if (entry.requestId !== 0) throw new Error(`ready state used unexpected request id ${entry.requestId}`)
              if (entry.json.errorCode) throw new Error(`ready state carried errorCode ${entry.json.errorCode}`)
              if (ready) throw new Error('worker emitted ready more than once')
              ready = true
              write(0x14, { op: 'key', scanCode: 30, pressed: true, extended: false }, undefined,
                { name: 'key', response: 'ack' })
              write(0x15, { op: 'pointer', x: 16, y: 16, buttons: 0, wheelX: 0, wheelY: 0 }, undefined,
                { name: 'pointer', response: 'ack' })
              write(0x13, { op: 'resize', width: 800, height: 600, dpi: 96 }, undefined,
                { name: 'resize', response: 'ack' })
              write(0x16, { op: 'clipboardSet', mime: 'text/plain', text: 'OpenFinalShell 中文 🚀' }, undefined,
                { name: 'clipboardSet', response: 'ack' })
              const clipboardId = requestId++
              ledger.register(clipboardId, 'clipboardGet', 'clipboardData')
              child.stdin.write(frame(0x17, clipboardId, { op: 'clipboardGet', requestId: clipboardId }))
              controlsSent = true
            } else if (entry.json.state === 'failed') {
              if (!config.acceptCertificate && promptSeen && entry.json.errorCode === 'CERTIFICATE_REJECTED') {
                certificateRejectionObserved = true
                continue
              }
              throw new Error(`worker failed with ${entry.json.errorCode ?? 'UNKNOWN'}`)
            } else if (entry.json.state === 'closed') {
              const completed = ledger.consume(entry)
              if (completed !== 'close') throw new Error('closed state did not complete close request')
              closed = true
            } else {
              ledger.consume(entry)
            }
          } else if (entry.type === 0x20 && entry.json.op === 'ack') {
            ledger.consume(entry)
            maybeClose()
          } else if (entry.type === 0x22 && entry.json.op === 'clipboardData') {
            assert.equal(entry.json.mime, 'text/plain', 'clipboard response uses text/plain')
            ledger.consume(entry)
            maybeClose()
          } else if (entry.type === 0x7f) {
            if (!config.acceptCertificate && promptSeen && entry.json.code === 'CERTIFICATE_REJECTED') {
              certificateRejectionObserved = true
              continue
            }
            ledger.consume(entry)
          } else {
            throw new Error(`unexpected worker message type ${entry.type}`)
          }
        }
      } catch (error) {
        finish(error)
      }
    })

    child.on('error', finish)
    child.on('exit', (code) => {
      if (settled) return
      if (!config.acceptCertificate && promptSeen) {
        if (!certificateRejectionObserved) finish(new Error(`${name} exited without a CERTIFICATE_REJECTED response`))
        else if (code === 0) finish(new Error(`${name} certificate rejection unexpectedly exited with code 0`))
        else finish(null, { failed: true, errorCode: 'CERTIFICATE_REJECTED' })
        return
      }
      try {
        validateAcceptedRdpSmokeExit({
          code,
          bufferedBytes: buffer.length,
          flags: { hello, credentialSent, ready, frameSeen, controlsSent, closeSent, closed },
          ledger
        })
        finish()
      } catch (error) {
        finish(new Error(`${error.message}; stderr=${stderr}`))
      }
    })
  })
}

const config = {
  host: requiredEnv('OFS_TEST_RDP_HOST'),
  port: numberEnv('OFS_TEST_RDP_PORT', 3389),
  username: requiredEnv('OFS_TEST_RDP_USERNAME'),
  password: process.env.OFS_TEST_RDP_PASSWORD ?? '',
  domain: process.env.OFS_TEST_RDP_DOMAIN ?? '',
  timeoutMs: Number(process.env.OFS_TEST_RDP_TIMEOUT_MS ?? 45000)
}

if (!config.host || !config.username || !config.password) {
  console.log('Skipping real RDP worker smoke: set OFS_TEST_RDP_HOST, OFS_TEST_RDP_USERNAME, and OFS_TEST_RDP_PASSWORD to enable it.')
  process.exit(0)
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log(`Skipping real RDP worker smoke: NATIVE-02 only gates Windows x64, current host is ${process.platform}/${process.arch}.`)
  process.exit(0)
}

selfTestHello()

const requireCertPrompt = truthy(process.env.OFS_TEST_RDP_EXPECT_CERT_PROMPT)
const runReject = requireCertPrompt || truthy(process.env.OFS_TEST_RDP_CERT_REJECT)

if (runReject) {
  const rejected = await runScenario('reject-cert', { ...config, acceptCertificate: false })
  if (!rejected.promptSeen) throw new Error('certificate reject scenario was requested but no certificate prompt was observed')
  if (rejected.promptSeen && rejected.errorCode !== 'CERTIFICATE_REJECTED') {
    throw new Error(`certificate reject scenario ended with ${rejected.errorCode ?? 'no error'}`)
  }
}

const accepted = await runScenario('accept-cert', { ...config, acceptCertificate: true })
if (requireCertPrompt && !accepted.promptSeen) throw new Error('certificate prompt was required but not observed')
if (!accepted.ready || !accepted.frameSeen) throw new Error('accepted RDP scenario did not reach ready with a framebuffer')
console.log('real RDP worker smoke passed')
