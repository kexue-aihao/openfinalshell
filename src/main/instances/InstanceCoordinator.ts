import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, lstatSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { databaseFile, metaGet, metaSet, prepare, tx } from '../store/Database'
import type { UpdateActivity, UpdateInstallResult, UpdateState } from '@shared/types'

export const configEntity = z.enum(['connections', 'references', 'ai', 'settings', 'snippets', 'forwards'])
export type ConfigEntity = z.infer<typeof configEntity>
export type ConfigChange = { entity: ConfigEntity; revision: number; sourceInstanceId: string }
const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('focus') }).strict(),
  z.object({ kind: z.literal('ping') }).strict(),
  z.object({ kind: z.literal('changed'), entity: configEntity, revision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('update'), op: z.enum(['state', 'check', 'download', 'install']), force: z.boolean() }).strict(),
  z.object({ kind: z.literal('activity') }).strict(),
  z.object({ kind: z.literal('prepareExit') }).strict()
])
export type ControlRequest = z.infer<typeof requestSchema>
type Reply = UpdateState | UpdateInstallResult | UpdateActivity | { ok: true } | void
interface Member { id: string; pid: number; version: string; endpoint: string; auth: string; started: number; heartbeat: number }
export interface CoordinatorOptions {
  id: string
  version: string
  onFocus: () => void
  onConfig: (change: ConfigChange) => void
  onLeader: (leader: boolean) => void
  onUpdateState?: (state: UpdateState) => void
  activity: () => UpdateActivity
  update: (op: 'state' | 'check' | 'download' | 'install', force: boolean) => Promise<Reply>
  prepareExit: () => Promise<void>
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** Darwin's sockaddr_un is limited to 104 bytes, including the terminating NUL. */
export function instanceEndpoint(databasePath: string, id: string, platform: NodeJS.Platform = process.platform): string {
  const namespace = createHash('sha256').update(databasePath).digest('hex').slice(0, 20)
  return platform === 'win32' ? `\\\\.\\pipe\\ofs-${namespace}-${id}` : `/tmp/ofs-ipc-${namespace}/${id}.sock`
}

/** Authenticated local socket only. SQL rows contain routing/authentication metadata, never application data. */
export class InstanceCoordinator {
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()
  private timer: NodeJS.Timeout | undefined
  private readonly revisions = new Map<ConfigEntity, number>()
  private readonly auth = randomBytes(32).toString('hex')
  private leader = false
  private stopped = false
  private polling = false
  private preparing = false
  private readonly started = Date.now()

  constructor(private readonly options: CoordinatorOptions) {}

  get isLeader(): boolean { return this.leader }
  get id(): string { return this.options.id }

  private members(): Member[] {
    return prepare('SELECT * FROM app_instances ORDER BY started, id').all() as unknown as Member[]
  }

  private prune(): void {
    for (const m of this.members()) if (!processAlive(m.pid)) {
      if (process.platform !== 'win32' && m.endpoint === instanceEndpoint(databaseFile(), m.id)) {
        try { if (lstatSync(m.endpoint).isSocket()) unlinkSync(m.endpoint) } catch { /* already removed */ }
      }
      prepare('DELETE FROM app_instances WHERE id = ?').run(m.id)
    }
  }

  assertCanStart(): void {
    const until = Number(metaGet('instance_install_until') ?? 0)
    if (until > Date.now()) throw new Error('正在协调安装更新，暂时不能打开新窗口，请等待安装完成。')
  }

  async start(): Promise<void> {
    const endpoint = instanceEndpoint(databaseFile(), this.id)
    if (process.platform !== 'win32') {
      mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 })
      const parent = lstatSync(dirname(endpoint))
      if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o077) !== 0 ||
          (process.getuid && parent.uid !== process.getuid())) throw new Error('Unsafe instance socket directory')
    }
    this.server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(endpoint, () => { this.server!.removeListener('error', reject); resolve() })
    })
    this.server.on('error', () => { /* requests time out explicitly; no unhandled socket error */ })
    try {
      tx(() => {
        this.assertCanStart()
        this.prune()
        prepare('INSERT INTO app_instances(id,pid,version,endpoint,auth,started,heartbeat) VALUES(?,?,?,?,?,?,?)')
          .run(this.id, process.pid, this.options.version, endpoint, this.auth, this.started, Date.now())
      })
      for (const row of this.readRevisions()) this.revisions.set(row.entity, row.revision)
      this.elect()
      this.timer = setInterval(() => { void this.poll().catch(() => {}) }, 2000)
      this.timer.unref()
    } catch (error) { this.server.close(); throw error }
  }

  private elect(): void {
    const id = tx(() => {
      this.prune()
      const members = this.members()
      const old = metaGet('instance_coordinator')
      const next = members.find((m) => m.id === old)?.id ?? members[0]?.id ?? ''
      if (old !== next) metaSet('instance_coordinator', next)
      return next
    })
    if (this.leader !== (id === this.id)) {
      this.leader = id === this.id
      this.options.onLeader(this.leader)
    } else if (this.leader) this.options.onLeader(true)
  }

  private readRevisions(): Array<{ entity: ConfigEntity; revision: number }> {
    return prepare('SELECT entity, revision FROM config_revisions').all() as Array<{ entity: ConfigEntity; revision: number }>
  }

  /** SQL revisions also catch changes made by imports, prompts and a missed socket notification. */
  async poll(): Promise<void> {
    if (this.stopped || this.polling) return
    this.polling = true
    try {
      prepare('UPDATE app_instances SET heartbeat = ? WHERE id = ?').run(Date.now(), this.id)
      this.elect()
      for (const row of this.readRevisions()) {
        if (this.revisions.get(row.entity) === row.revision) continue
        this.acceptRevision({ ...row, sourceInstanceId: this.id })
        await Promise.allSettled(this.members().filter((m) => m.id !== this.id).map((m) => this.request(m, { kind: 'changed', ...row })))
        if (this.stopped) return
      }
      if (!this.leader && this.options.onUpdateState) {
        const state = await this.requestUpdate('state') as UpdateState
        if (!this.stopped) this.options.onUpdateState(state)
      }
    } finally { this.polling = false }
  }

  private acceptRevision(change: ConfigChange): void {
    if ((this.revisions.get(change.entity) ?? -1) >= change.revision) return
    this.revisions.set(change.entity, change.revision)
    this.options.onConfig(change)
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => this.sockets.delete(socket))
    socket.setTimeout(30_000, () => socket.destroy())
    let bytes = Buffer.alloc(0)
    let consumed = false
    socket.on('data', (chunk: Buffer) => {
      if (consumed) return
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > 8192) { socket.destroy(); return }
      if (!bytes.includes(10)) return
      consumed = true
      void (async () => {
        const envelope = z.object({ source: z.string().uuid(), auth: z.string().length(64), request: requestSchema }).strict().parse(JSON.parse(bytes.toString('utf8').trim()))
        if (!timingSafeEqual(Buffer.from(envelope.auth), Buffer.from(this.auth))) throw new Error('Unauthorized')
        if (!this.members().some((m) => m.id === envelope.source)) throw new Error('Unknown instance')
        const result = await this.dispatch(envelope.source, envelope.request)
        socket.end(JSON.stringify({ ok: true, result }) + '\n')
      })().catch(() => { socket.end(JSON.stringify({ ok: false, error: '实例控制请求失败，请重试或检查其他窗口状态。' }) + '\n') })
    })
  }

  private async dispatch(source: string, request: ControlRequest): Promise<Reply> {
    switch (request.kind) {
      case 'ping': return { ok: true }
      case 'focus': this.options.onFocus(); return { ok: true }
      case 'activity': return this.options.activity()
      case 'changed': {
        if (source !== this.id) {
          const actual = this.readRevisions().find((r) => r.entity === request.entity)?.revision
          if (actual === request.revision) this.acceptRevision({ entity: request.entity, revision: actual, sourceInstanceId: source })
        }
        return { ok: true }
      }
      case 'update':
        if (!this.leader) throw new Error('Coordinator changed')
        return this.options.update(request.op, request.force)
      case 'prepareExit':
        if (source !== metaGet('instance_coordinator') || metaGet('instance_install_owner') !== source) throw new Error('Not coordinating an update')
        if (!this.preparing) {
          this.preparing = true
          try { await this.options.prepareExit() } finally { this.preparing = false }
        }
        return { ok: true }
    }
  }

  private request(member: Member, request: ControlRequest): Promise<Reply> {
    if (this.stopped) return Promise.reject(new Error('实例正在退出。'))
    return new Promise((resolve, reject) => {
      const socket = createConnection(member.endpoint)
      this.sockets.add(socket)
      let bytes = Buffer.alloc(0)
      let settled = false
      const finish = (error?: Error, value?: Reply): void => {
        if (settled) return
        settled = true
        socket.destroy()
        this.sockets.delete(socket)
        error ? reject(error) : resolve(value)
      }
      socket.on('close', () => finish(new Error('实例控制连接已关闭')))
      socket.setTimeout(25_000, () => finish(new Error(`实例 ${member.id}（PID ${member.pid}）未响应`)))
      socket.on('error', () => finish(new Error(`实例 ${member.id}（PID ${member.pid}）无法连接`)))
      socket.on('connect', () => socket.write(JSON.stringify({ source: this.id, auth: member.auth, request }) + '\n'))
      socket.on('end', () => finish(new Error('实例控制连接已关闭')))
      socket.on('data', (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk])
        if (bytes.length > 64 * 1024) { finish(new Error('Invalid control response')); return }
        if (!bytes.includes(10)) return
        try {
          const response = JSON.parse(bytes.toString('utf8').trim()) as { ok: boolean; error?: string; result?: Reply }
          finish(response.ok ? undefined : new Error(response.error ?? '实例控制请求失败'), response.result)
        } catch { finish(new Error('Invalid control response')) }
      })
    })
  }

  async requestUpdate(op: 'state' | 'check' | 'download' | 'install', force = false): Promise<Reply> {
    this.elect()
    const leader = this.members().find((m) => m.id === metaGet('instance_coordinator'))
    if (!leader) throw new Error('更新协调窗口暂不可用，请重试。')
    return leader.id === this.id ? this.options.update(op, force) : this.request(leader, { kind: 'update', op, force })
  }

  async focusLeader(): Promise<void> {
    const member = this.members().find((m) => m.id === metaGet('instance_coordinator'))
    if (member) await this.request(member, { kind: 'focus' })
  }

  snapshot(): Array<{ id: string; pid: number; version: string; heartbeat: number }> {
    return this.members().map(({ id, pid, version, heartbeat }) => ({ id, pid, version, heartbeat }))
  }

  async allActivity(): Promise<UpdateActivity> {
    const result = { ...this.options.activity() }
    for (const m of this.members()) {
      if (m.id === this.id) continue
      const a = await this.request(m, { kind: 'activity' }) as UpdateActivity
      for (const key of ['sessions', 'transfers', 'forwards'] as const) result[key] += a[key]
    }
    return result
  }

  /** Hold an admission barrier until installation or abort; never kill an unresponsive process. */
  async prepareInstall(): Promise<void> {
    tx(() => {
      if (metaGet('instance_coordinator') !== this.id) throw new Error('更新协调窗口已变化，请重试。')
      this.assertCanStart()
      metaSet('instance_install_owner', this.id)
      metaSet('instance_install_until', String(Date.now() + 300_000))
    })
    try {
      const peers = this.members().filter((m) => m.id !== this.id)
      const results = await Promise.allSettled(peers.map((m) => this.request(m, { kind: 'prepareExit' })))
      // The peer may exit before sending its final ack. A dead PID is sufficient; an ack alone is not.
      const deadline = Date.now() + 20_000
      let alive = peers.filter((m) => processAlive(m.pid))
      while (alive.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        alive = peers.filter((m) => processAlive(m.pid))
      }
      if (alive.length) throw new Error(`以下窗口仍在运行，更新未安装：${alive.map((m) => `${m.id} (PID ${m.pid})`).join(', ')}`)
      void results
    } catch (error) { this.cancelInstall(); throw error }
  }

  cancelInstall(): void {
    tx(() => {
      if (metaGet('instance_install_owner') === this.id) { metaSet('instance_install_until', '0'); metaSet('instance_install_owner', '') }
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => { if (this.server) this.server.close(() => resolve()); else resolve() })
    tx(() => {
      prepare('DELETE FROM app_instances WHERE id = ?').run(this.id)
      if (metaGet('instance_coordinator') === this.id) metaSet('instance_coordinator', '')
    })
  }
}
