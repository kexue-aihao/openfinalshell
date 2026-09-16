/** Real Electron processes + local SSH/SFTP + mock AI HTTP. Never uses the user's configuration. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as tcpServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const root = mkdtempSync(join(tmpdir(), 'ofs-multi-smoke-'))
const data = join(root, 'user-data'), remote = join(root, 'remote')
mkdirSync(data); mkdirSync(remote)
const exe = process.argv[2] || resolve('node_modules/electron/dist/electron.exe')
const dev = /^electron(?:\.exe)?$/i.test(basename(exe))
const processes = [], sockets = [], report = []
const launchErrors = []
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (launchErrors.length) throw launchErrors[0]; const result = await fn(); if (result) return result; await delay(100) }
  throw new Error('Smoke condition timed out')
}
async function port() {
  const s = tcpServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const p = s.address().port; await new Promise((r) => s.close(r)); return p
}
function launch(args) {
  const child = spawn(exe, [...(dev ? [resolve('.')] : []), `--user-data-dir=${data}`, ...args], { env, stdio: 'ignore', windowsHide: true })
  child.once('error', (error) => launchErrors.push(error))
  processes.push(child); return child
}
async function connect(cdpPort) {
  const target = await until(async () => {
    try { const tabs = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); return tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) } catch { return false }
  }, 40000)
  const ws = new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws)
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data); const waiter = pending.get(msg.id)
    if (waiter) { pending.delete(msg.id); clearTimeout(waiter.timer); msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result) }
  })
  async function evaluate(body) {
    const id = ++seq
    const promise = new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out')) }, 30000); pending.set(id, { resolve, reject, timer }) })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true } }))
    const value = await promise
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || 'Renderer error')
    return value.result.value
  }
  await until(() => evaluate('return !!window.ofs').catch(() => false))
  return { evaluate, invoke: (channel, ...args) => evaluate(`return await window.ofs.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`) }
}
function passed(name) { report.push(name); console.log(`PASS ${name}`) }
function writeReport(extra) {
  const result = JSON.stringify({ timestamp: new Date().toISOString(), platform: process.platform, report, ...extra }, null, 2)
  writeFileSync(join(root, 'report.json'), result)
  if (process.env.OFS_MULTI_INSTANCE_REPORT) {
    mkdirSync(dirname(process.env.OFS_MULTI_INSTANCE_REPORT), { recursive: true })
    writeFileSync(process.env.OFS_MULTI_INSTANCE_REPORT, result)
  }
}

let ssh, ai
try {
  if (!existsSync(exe)) throw new Error('Electron executable is missing; run node node_modules/electron/install.js before this smoke test.')
  const sshPort = await port()
  ssh = spawn(process.execPath, ['test/fixtures/testSshServer.mjs', String(sshPort), remote], { env: { ...env, OFS_TEST_SFTP_READ_DELAY_MS: '500' }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  await new Promise((r, j) => { const timer = setTimeout(() => j(new Error('SSH fixture startup timeout')), 15000); ssh.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); r() } }) })
  ai = httpServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'instance-local-ai-result' } }] }))
  })
  await new Promise((r) => ai.listen(0, '127.0.0.1', r))
  const aiPort = ai.address().port
  const [pA, pB, pNormal] = await Promise.all([port(), port(), port()])
  const procA = launch(['--new-instance', `--remote-debugging-port=${pA}`])
  // Both processes start against an empty userData: Chromium must share one protected encryption key.
  const procB = launch(['--new-instance', `--remote-debugging-port=${pB}`])
  const [a, b] = await Promise.all([connect(pA), connect(pB)])
  const infoA = await a.invoke('app:instanceInfo')
  const ordinary = launch([`--remote-debugging-port=${pNormal}`])
  await until(() => ordinary.exitCode !== null)
  assert.equal(ordinary.exitCode, 0)
  passed('ordinary second launch exits and retains the first window')
  const infoB = await b.invoke('app:instanceInfo')
  assert.notEqual(infoA.instanceId, infoB.instanceId); assert.notEqual(infoA.pid, infoB.pid)
  passed('simultaneous first startup shares initialization with distinct UUIDs and processes')

  for (const client of [a, b]) await client.evaluate(`
    window.__events=[];
    for(const channel of ['term:data','transfer:progress','transfer:states','ai:delta','ai:completed','app:configChanged']) window.ofs.on(channel,payload=>window.__events.push({channel,payload}));
    window.ofs.on('session:prompt', p=>window.ofs.invoke('session:promptReply',{requestId:p.requestId,ok:true,remember:true,answers:['test123']}));
  `)
  const draft = { name: 'multi-smoke-a', groupId: null, host: '127.0.0.1', port: sshPort, username: 'test', auth: { method: 'password', password: 'test123' }, terminal: { charset: 'utf-8', termType: 'xterm' }, options: { keepaliveInterval: 15000, readyTimeout: 10000, legacyAlgorithms: false, autoReconnect: false, monitorEnabled: false, compress: false } }
  const [profileA, profileB] = await Promise.all([a.invoke('conn:save', draft), b.invoke('conn:save', { ...draft, name: 'multi-smoke-b' })])
  const profiles = await b.invoke('conn:list')
  assert.equal(profiles.profiles.length, 2)
  const otherRead = profiles.profiles.find((p) => p.id === profileA.id)
  await a.invoke('conn:save', { ...draft, id: profileA.id, expectedUpdatedAt: profileA.updatedAt, name: 'changed-a' })
  await assert.rejects(b.invoke('conn:save', { ...draft, id: otherRead.id, expectedUpdatedAt: otherRead.updatedAt, name: 'stale-b' }), /CONFIG_CONFLICT/)
  await until(() => b.evaluate("return window.__events.some(e=>e.channel==='app:configChanged'&&e.payload.entity==='connections')"))
  passed('shared encrypted profiles, concurrent writes, stale-edit rejection and config notification')

  const [sessionA, sessionB] = await Promise.all([a.invoke('session:open', profileA.id), b.invoke('session:open', profileB.id)])
  const termA = await a.invoke('term:open', { sessionId: sessionA.sessionId, cols: 80, rows: 24 })
  const termB = await b.invoke('term:open', { sessionId: sessionB.sessionId, cols: 80, rows: 24 })
  await a.invoke('term:exec', { termId: termA.termId, command: 'echo isolated-a\r' })
  await b.invoke('term:exec', { termId: termB.termId, command: 'echo isolated-b\r' })
  await until(() => a.evaluate(`return window.__events.some(e=>e.channel==='term:data'&&new TextDecoder().decode(new Uint8Array(e.payload.data)).includes('isolated-a'))`))
  assert.equal(await b.evaluate(`return window.__events.some(e=>e.payload.termId===${JSON.stringify(termA.termId)})`), false)
  await assert.rejects(b.invoke('term:exec', { termId: termA.termId, command: 'echo must-not-run' }))
  passed('real SSH sessions and terminal bytes stay in the owning instance')

  const local = join(root, 'upload.bin'), downloaded = join(root, 'download.bin')
  const bytes = Buffer.alloc(128 * 1024, 37); writeFileSync(local, bytes)
  const [task] = await a.invoke('transfer:enqueue', [{ sessionId: sessionA.sessionId, kind: 'upload', localPath: local, remotePath: '/upload.bin' }])
  await until(async () => (await a.invoke('transfer:list')).some((t) => t.id === task && t.state === 'done'))
  assert.equal((await b.invoke('transfer:list')).length, 0)
  const [download] = await b.invoke('transfer:enqueue', [{ sessionId: sessionB.sessionId, kind: 'download', localPath: downloaded, remotePath: '/upload.bin' }])
  await until(async () => (await b.invoke('transfer:list')).some((t) => t.id === download && t.state === 'done'))
  assert.deepEqual(readFileSync(downloaded), bytes)
  passed('real SFTP upload/download retains identical bytes and independent queues')

  const aiProfile = await a.invoke('ai:profiles:save', { name: 'local-test', model: 'fixture', baseUrl: `http://127.0.0.1:${aiPort}/v1`, token: 'smoke-ai-token' })
  assert.equal((await b.invoke('ai:profiles:list')).some((p) => p.id === aiProfile.id && p.hasToken), true)
  await a.invoke('settings:set', { aiAssistantEnabled: true })
  await b.invoke('ai:chat', { profileId: aiProfile.id, requestId: 'smoke-b-ai', messages: [{ role: 'user', content: 'local test' }], stream: false })
  await until(() => b.evaluate("return window.__events.some(e=>e.channel==='ai:completed'&&e.payload.requestId==='smoke-b-ai')"))
  assert.equal(await a.evaluate("return window.__events.some(e=>e.payload.requestId==='smoke-b-ai')"), false)
  passed('AI token is shared through Vault while response events remain instance-local')

  const slowBytes = Buffer.alloc(16 * 1024 * 1024, 81), slowDestination = join(root, 'surviving-download.bin')
  writeFileSync(join(remote, 'slow.bin'), slowBytes)
  const [survivingTask] = await b.invoke('transfer:enqueue', [{ sessionId: sessionB.sessionId, kind: 'download', localPath: slowDestination, remotePath: '/slow.bin' }])
  await until(async () => (await b.invoke('transfer:list')).some((t) => t.id === survivingTask && t.state === 'running'))
  await a.evaluate('window.close()').catch(() => {})
  await until(() => procA.exitCode !== null)
  assert.equal(procB.exitCode, null)
  await until(async () => (await b.invoke('transfer:list')).some((t) => t.id === survivingTask && t.state === 'done'))
  assert.deepEqual(readFileSync(slowDestination), slowBytes)
  passed('closing A leaves B active SFTP transfer running to an identical result')
  await b.invoke('term:exec', { termId: termB.termId, command: 'echo survives-a-exit\r' })
  await until(() => b.evaluate("return window.__events.some(e=>e.channel==='term:data'&&new TextDecoder().decode(new Uint8Array(e.payload.data)).includes('survives-a-exit'))"))
  await delay(2500)
  const afterExit = launch([])
  await until(() => afterExit.exitCode !== null)
  passed('closing A preserves B SSH; B takes the default startup lock')
  const update = await b.invoke('update:check')
  assert.equal(typeof update.status, 'string')

  // Create two more explicit processes to cover UUID uniqueness for three concurrent windows.
  const pC = await port(), pD = await port()
  const procC = launch(['--new-instance', `--remote-debugging-port=${pC}`])
  const procD = launch(['--new-instance', `--remote-debugging-port=${pD}`])
  const [c, d] = await Promise.all([connect(pC), connect(pD)])
  const [infoC, infoD] = await Promise.all([c.invoke('app:instanceInfo'), d.invoke('app:instanceInfo')])
  assert.equal(new Set([infoB.instanceId, infoC.instanceId, infoD.instanceId]).size, 3)
  passed('three simultaneous explicit instances have unique identities')
  for (const client of [b, c, d]) await client.evaluate('window.close()').catch(() => {})
  await until(() => [procB, procC, procD].every((p) => p.exitCode !== null))
  const pRestart = await port()
  const restarted = launch([`--remote-debugging-port=${pRestart}`])
  const r = await connect(pRestart)
  assert.equal((await r.invoke('conn:list')).profiles.length, 2)
  assert.equal((await r.invoke('ai:profiles:list')).some((p) => p.id === aiProfile.id && p.hasToken), true)
  await r.evaluate("window.__completed=false; window.ofs.on('ai:completed',()=>window.__completed=true)")
  await r.invoke('ai:chat', { profileId: aiProfile.id, requestId: 'restart-ai', messages: [{ role: 'user', content: 'restart test' }], stream: false })
  await until(() => r.evaluate('return window.__completed'))
  await r.evaluate('window.close()').catch(() => {})
  await until(() => restarted.exitCode !== null)
  passed('full restart decrypts shared connection data and the original Vault token')
  const logs = join(data, 'logs')
  for (const file of readdirSync(logs)) {
    const text = readFileSync(join(logs, file), 'utf8')
    assert(!text.includes('smoke-ai-token')); assert(!text.includes('test123'))
  }
  passed('instance logs contain no test passwords or API tokens')
  writeReport({ passed: true, sha256: createHash('sha256').update(bytes).digest('hex'), externalRdp: 'not tested; requires a Windows RDP target', updateInstaller: 'not executed' })
  console.log(`Report: ${join(root, 'report.json')}`)
} catch (error) {
  writeReport({ passed: false, failure: error instanceof Error ? error.message : 'Smoke failed' })
  console.error(error); process.exitCode = 1
  console.error(`Isolated diagnostics retained at ${root}`)
} finally {
  for (const socket of sockets) socket.close()
  for (const child of processes) if (child.exitCode === null) child.kill()
  ssh?.kill(); ai?.close()
}
