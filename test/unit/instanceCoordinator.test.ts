import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstanceCoordinator, instanceEndpoint } from '../../src/main/instances/InstanceCoordinator'
import { closeDatabase, metaSet, prepare } from '../../src/main/store/Database'

const running: InstanceCoordinator[] = []
function create(prepareExit: () => Promise<void> = async () => {}) {
  const onConfig = vi.fn(), onLeader = vi.fn(), update = vi.fn(async () => ({ ok: true as const }))
  const coordinator = new InstanceCoordinator({ id: randomUUID(), version: 'test', onFocus: vi.fn(), onConfig, onLeader,
    update, activity: () => ({ sessions: 1, transfers: 2, forwards: 3 }), prepareExit })
  running.push(coordinator)
  return { coordinator, onConfig, onLeader, update }
}
afterEach(async () => { for (const c of running.splice(0)) await c.stop(); closeDatabase() })

describe('real local instance control transport', () => {
  it('fits macOS Unix socket limits even for long user data paths', () => {
    const id = randomUUID(), profile = '/var/folders/ab/' + 'x'.repeat(120) + '/OpenFinalShell/openfinalshell.db'
    const endpoint = instanceEndpoint(profile, id, 'darwin')
    expect(Buffer.byteLength(endpoint)).toBeLessThan(104)
    expect(endpoint.startsWith('/tmp/')).toBe(true)
    expect(instanceEndpoint(profile + '-other', id, 'darwin')).not.toBe(endpoint)
    expect(instanceEndpoint(profile, randomUUID(), 'darwin')).not.toBe(endpoint)
    expect(instanceEndpoint(profile, id, 'win32').startsWith('\\\\.\\pipe\\')).toBe(true)
  })
  it('elects one leader, forwards update requests, then elects a survivor', async () => {
    const a = create(), b = create()
    await a.coordinator.start(); await b.coordinator.start()
    expect(a.coordinator.isLeader).toBe(true)
    expect(b.coordinator.isLeader).toBe(false)
    await b.coordinator.requestUpdate('check')
    expect(a.update).toHaveBeenCalledWith('check', false)
    expect(b.update).not.toHaveBeenCalled()
    expect(await a.coordinator.allActivity()).toEqual({ sessions: 2, transfers: 4, forwards: 6 })
    await a.coordinator.stop(); running.splice(running.indexOf(a.coordinator), 1)
    await b.coordinator.poll()
    expect(b.coordinator.isLeader).toBe(true)
  })

  it('notifies revisions over a real socket once, without sending configuration contents', async () => {
    const a = create(), b = create()
    await a.coordinator.start(); await b.coordinator.start()
    prepare('INSERT INTO documents(name,json) VALUES (?,?)').run('control-test', '{"private":"do-not-send"}')
    await a.coordinator.poll()
    expect(b.onConfig).toHaveBeenCalledOnce()
    expect(b.onConfig.mock.calls[0][0]).toMatchObject({ entity: 'settings', sourceInstanceId: a.coordinator.id })
    expect(JSON.stringify(b.onConfig.mock.calls)).not.toContain('do-not-send')
    await a.coordinator.poll(); await b.coordinator.poll()
    expect(b.onConfig).toHaveBeenCalledOnce()
  })

  it('blocks admissions during installation and rejects control payloads outside the allowlist', async () => {
    const a = create(); await a.coordinator.start()
    metaSet('instance_install_until', String(Date.now() + 60000))
    expect(() => a.coordinator.assertCanStart()).toThrow('安装更新')
    metaSet('instance_install_until', '0')
    const row = prepare('SELECT endpoint, auth FROM app_instances WHERE id = ?').get(a.coordinator.id) as { endpoint: string; auth: string }
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(row.endpoint)
      socket.on('error', reject)
      socket.on('connect', () => socket.write(JSON.stringify({ source: a.coordinator.id, auth: row.auth, request: { kind: 'changed', entity: 'settings', revision: 99, password: 'must-reject' } }) + '\n'))
      socket.once('data', (data) => { resolve(data.toString()); socket.destroy() })
    })
    expect(JSON.parse(reply).ok).toBe(false)
    expect(reply).not.toContain('must-reject')
    expect(a.onConfig).not.toHaveBeenCalled()
  })

  it('waits for an acknowledged peer to actually exit before allowing install', async () => {
    const a = create(); await a.coordinator.start()
    const row = prepare('SELECT endpoint, auth FROM app_instances WHERE id = ?').get(a.coordinator.id) as { endpoint: string; auth: string }
    const peerId = randomUUID(), endpoint = row.endpoint.replace(a.coordinator.id, peerId)
    const child = spawn(process.execPath, ['-e', `
      const {createServer}=require('node:net');
      const server=createServer(s=>s.once('data',()=>{s.end('{"ok":true}\\n');setTimeout(()=>process.exit(0),250);}));
      server.listen(process.argv[1],()=>process.stdout.write('ready'));
    `, endpoint], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    try {
      await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('error', reject) })
      prepare('INSERT INTO app_instances(id,pid,version,endpoint,auth,started,heartbeat) VALUES(?,?,?,?,?,?,?)')
        .run(peerId, child.pid!, 'test', endpoint, row.auth, Date.now(), Date.now())
      const start = Date.now()
      await a.coordinator.prepareInstall()
      expect(Date.now() - start).toBeGreaterThanOrEqual(200)
      expect(child.exitCode).toBe(0)
      expect(() => a.coordinator.assertCanStart()).toThrow('安装更新')
      a.coordinator.cancelInstall()
    } finally { if (child.exitCode === null) child.kill(); prepare('DELETE FROM app_instances WHERE id = ?').run(peerId) }
  })

  it('permits a new exit request after an editor cancels the previous attempt', async () => {
    const prepareExit = vi.fn().mockRejectedValueOnce(new Error('editor cancelled')).mockResolvedValue(undefined)
    const a = create(), b = create(prepareExit)
    await a.coordinator.start(); await b.coordinator.start()
    metaSet('instance_install_owner', a.coordinator.id)
    const row = prepare('SELECT endpoint, auth FROM app_instances WHERE id = ?').get(b.coordinator.id) as { endpoint: string; auth: string }
    const request = () => new Promise<{ ok: boolean }>((resolve, reject) => {
      const socket = createConnection(row.endpoint)
      socket.on('error', reject)
      socket.on('connect', () => socket.write(JSON.stringify({ source: a.coordinator.id, auth: row.auth, request: { kind: 'prepareExit' } }) + '\n'))
      socket.once('data', (data) => { resolve(JSON.parse(data.toString())); socket.destroy() })
    })
    expect((await request()).ok).toBe(false)
    expect((await request()).ok).toBe(true)
    expect(prepareExit).toHaveBeenCalledTimes(2)
  })

  it('reports an unresponsive window without killing it and releases the admission barrier', async () => {
    const a = create(), b = create()
    await a.coordinator.start(); await b.coordinator.start()
    // Both test servers belong to this live process. An acknowledgement is not proof of process exit.
    const installing = expect(a.coordinator.prepareInstall()).rejects.toThrow(`PID ${process.pid}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(() => a.coordinator.assertCanStart()).toThrow('安装更新')
    await installing
    expect(() => a.coordinator.assertCanStart()).not.toThrow()
    expect(await b.coordinator.requestUpdate('state')).toEqual({ ok: true })
  })
})
