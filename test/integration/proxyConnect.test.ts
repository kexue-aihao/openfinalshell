/**
 * 经代理连接的端到端链路：profile.proxyId → SavedProxy → buildConnectConfig → dialThroughProxy → ssh2 → shell。
 *
 * 代理用本进程起的假代理（会统计连接数并把流量转给 fixture sshd），所以整条链路可离线验证：
 * 断言"确实走了代理"而不只是"连上了" —— 直连也能连上 fixture，光看结果分不出来。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ProfileDraft } from '@shared/types'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, getProfile, saveProfile } from '../../src/main/store/connections'
import { getProxy, saveProxy } from '../../src/main/store/savedRefs'
import { vault } from '../../src/main/store/Vault'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { promptBroker } from '../../src/main/ssh/PromptBroker'

const SSH_PORT = 2280

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
function eventsOf<K extends keyof EventMap>(channel: K): Array<EventMap[K]> {
  return events.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
}

async function waitFor(pred: () => boolean, ms = 15000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

// ---------------- 假代理 ----------------

interface FakeProxy {
  port: number
  /** 完成握手并开始转发的次数 */
  tunnels: number
  /** 每次 CONNECT 请求的目标（验证是否把真实目标交给了代理） */
  targets: string[]
  /** 收到的认证凭据 */
  credentials: string[]
  close: () => Promise<void>
}

const openProxies: FakeProxy[] = []

/** 缓冲读取器：不能"读完就摘监听"，否则两次读之间到达的字节会被 flowing 模式丢掉 */
class Reader {
  private buf: Buffer = Buffer.alloc(0)
  private pending: { want: (b: Buffer) => number | null; resolve: (b: Buffer) => void } | null = null

  constructor(socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk])
      this.serve()
    })
  }
  private serve(): void {
    const p = this.pending
    if (!p) return
    const size = p.want(this.buf)
    if (size === null) return
    this.pending = null
    const out = this.buf.subarray(0, size)
    this.buf = this.buf.subarray(size)
    p.resolve(out)
  }
  private read(want: (b: Buffer) => number | null): Promise<Buffer> {
    return new Promise((resolve) => {
      this.pending = { want, resolve }
      this.serve()
    })
  }
  exactly(n: number): Promise<Buffer> {
    return this.read((b) => (b.length >= n ? n : null))
  }
  untilDoubleCrlf(): Promise<string> {
    return this.read((b) => {
      const end = b.indexOf('\r\n\r\n')
      return end >= 0 ? end + 4 : null
    }).then((b) => b.toString('latin1'))
  }
  /** 交接给转发前把已缓冲但未消费的字节交出来 */
  drain(): Buffer {
    const out = this.buf
    this.buf = Buffer.alloc(0)
    return out
  }
}

async function startFakeProxy(opts: {
  kind: 'http' | 'socks5'
  requireAuth?: boolean
  /** 拒绝所有 CONNECT，用于验证错误文案 */
  refuse?: boolean
}): Promise<FakeProxy> {
  const state: FakeProxy = {
    port: 0,
    tunnels: 0,
    targets: [],
    credentials: [],
    close: async () => {}
  }
  const live: Socket[] = []

  const relay = (client: Socket, reader: Reader, host: string, port: number): void => {
    state.tunnels += 1
    const upstream = connect({ host, port })
    live.push(upstream)
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    const leftover = reader.drain()
    if (leftover.length > 0) upstream.write(leftover)
    client.pipe(upstream)
    upstream.pipe(client)
  }

  const server: Server = createServer((client) => {
    live.push(client)
    const reader = new Reader(client)
    void (async () => {
      try {
        if (opts.kind === 'http') {
          const head = await reader.untilDoubleCrlf()
          const target = /^CONNECT[ \t]+(\S+)/.exec(head)?.[1] ?? ''
          state.targets.push(target)
          const auth = /Proxy-Authorization:[ \t]*Basic[ \t]+(\S+)/i.exec(head)?.[1]
          if (auth) state.credentials.push(Buffer.from(auth, 'base64').toString('utf8'))
          if (opts.requireAuth && !auth) {
            client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
            return
          }
          if (opts.refuse) {
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
            return
          }
          const [host, port] = target.split(':')
          client.write('HTTP/1.1 200 Connection established\r\n\r\n')
          relay(client, reader, host, Number(port))
          return
        }

        // SOCKS5
        const greeting = await reader.exactly(2)
        const methods = await reader.exactly(greeting[1])
        if (opts.requireAuth) {
          if (!methods.includes(0x02)) {
            client.end(Buffer.from([0x05, 0xff]))
            return
          }
          client.write(Buffer.from([0x05, 0x02]))
          const head = await reader.exactly(2)
          const user = await reader.exactly(head[1])
          const plen = await reader.exactly(1)
          const pass = await reader.exactly(plen[0])
          state.credentials.push(`${user.toString()}:${pass.toString()}`)
          client.write(Buffer.from([0x01, 0x00]))
        } else {
          client.write(Buffer.from([0x05, 0x00]))
        }
        const req = await reader.exactly(4)
        const atyp = req[3]
        let host: string
        if (atyp === 0x01) {
          host = [...(await reader.exactly(4))].join('.')
        } else if (atyp === 0x03) {
          const len = await reader.exactly(1)
          host = (await reader.exactly(len[0])).toString()
        } else {
          host = (await reader.exactly(16)).toString('hex')
        }
        const port = (await reader.exactly(2)).readUInt16BE(0)
        state.targets.push(`${host}:${port}`)
        if (opts.refuse) {
          client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          return
        }
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        relay(client, reader, host, port)
      } catch {
        client.destroy()
      }
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.port = (server.address() as AddressInfo).port
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const s of live) s.destroy()
      server.close(() => resolve())
    })
  openProxies.push(state)
  return state
}

// ---------------- fixture sshd ----------------

let sshServer: ChildProcess
let autoTrust: ReturnType<typeof setInterval>
const createdProfiles: string[] = []

beforeAll(async () => {
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  sshServer = spawn(process.execPath, ['test/fixtures/testSshServer.mjs', String(SSH_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test ssh server did not start')), 10000)
    sshServer.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  // fixture 的 hostkey 每次重启都变，自动应答 TOFU 弹窗；不应答会一直等到 readyTimeout
  autoTrust = setInterval(() => {
    for (const p of eventsOf('session:prompt')) {
      if (p.kind === 'hostkey-new' || p.kind === 'hostkey-changed') {
        promptBroker.reply({ requestId: p.requestId, ok: true, remember: true })
      }
    }
  }, 20)
})

afterAll(() => {
  clearInterval(autoTrust)
  sshManager.closeAll()
  sshServer?.kill()
})

afterEach(async () => {
  sshManager.closeAll()
  for (const id of createdProfiles.splice(0)) deleteProfile(id)
  await Promise.all(openProxies.splice(0).map((p) => p.close()))
})

/**
 * 代理不再内联在连接上（v0.4 起是可复用实体），所以这里先存一条 SavedProxy 再引用它。
 * 传 null 表示直连。
 */
type ProxySpec = { type: 'http' | 'socks5'; host: string; port: number; username?: string; password?: string } | null

function draft(proxy: ProxySpec, name = 'via-proxy'): ProfileDraft {
  const proxyId = proxy
    ? saveProxy({ name: `${name}-proxy`, type: proxy.type, host: proxy.host, port: proxy.port,
                  username: proxy.username, password: proxy.password }).id
    : undefined
  return {
    name,
    groupId: null,
    host: '127.0.0.1',
    port: SSH_PORT,
    username: 'test',
    auth: { method: 'password', password: 'test123' },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 10000,
      legacyAlgorithms: false,
      autoReconnect: false,
      monitorEnabled: false,
      compress: false
    },
    proxyId
  }
}

async function openVia(proxy: ProxySpec): Promise<string> {
  const profile = saveProfile(draft(proxy))
  createdProfiles.push(profile.id)
  const { sessionId } = await sshManager.open(profile.id)
  return sessionId
}

/** 开一个 shell 敲命令，证明隧道里跑的是可用的 SSH 会话而不只是握手成功 */
async function echoThroughShell(sessionId: string, text: string): Promise<string> {
  const conn = sshManager.get(sessionId)
  const shell = await conn.openShell(80, 24)
  let out = ''
  const collect = setInterval(() => {
    for (const e of eventsOf('term:data')) {
      if (e.termId === shell.termId) out += Buffer.from(e.data).toString('utf8')
    }
  }, 20)
  shell.write(`echo ${text}\n`)
  try {
    await waitFor(() => out.includes(text), 10000, 'shell echo')
  } finally {
    clearInterval(collect)
    shell.close()
  }
  return out
}

describe('经代理连接', () => {
  it('HTTP 代理：隧道打通且真的走了代理', async () => {
    const proxy = await startFakeProxy({ kind: 'http' })
    const sessionId = await openVia({ type: 'http', host: '127.0.0.1', port: proxy.port })

    expect(eventsOf('session:state').at(-1)?.state).toBe('ready')
    expect(proxy.tunnels).toBe(1)
    expect(proxy.targets).toEqual([`127.0.0.1:${SSH_PORT}`])
    await expect(echoThroughShell(sessionId, 'through-http-proxy')).resolves.toContain(
      'through-http-proxy'
    )
  })

  it('SOCKS5 代理：隧道打通且真的走了代理', async () => {
    const proxy = await startFakeProxy({ kind: 'socks5' })
    const sessionId = await openVia({ type: 'socks5', host: '127.0.0.1', port: proxy.port })

    expect(proxy.tunnels).toBe(1)
    expect(proxy.targets).toEqual([`127.0.0.1:${SSH_PORT}`])
    await expect(echoThroughShell(sessionId, 'through-socks5-proxy')).resolves.toContain(
      'through-socks5-proxy'
    )
  })

  it('代理密码只落 Vault 引用，不回传 renderer', async () => {
    const proxy = await startFakeProxy({ kind: 'socks5', requireAuth: true })
    const profile = saveProfile(
      draft({
        type: 'socks5',
        host: '127.0.0.1',
        port: proxy.port,
        username: 'pu',
        password: 'p-secret'
      })
    )
    createdProfiles.push(profile.id)

    // 连接上只有一个 proxyId；密码的 Vault 引用归那条 SavedProxy
    expect(profile.proxyId).toBeTruthy()
    expect(JSON.stringify(profile)).not.toContain('p-secret')
    const savedProxy = getProxy(profile.proxyId!)!
    expect(savedProxy.passwordRef).toBeTruthy()
    expect(JSON.stringify(savedProxy)).not.toContain('p-secret')
    expect(vault.getSecret(savedProxy.passwordRef!)).toBe('p-secret')

    await sshManager.open(profile.id)
    expect(proxy.credentials).toEqual(['pu:p-secret'])
  })

  /**
   * 把连接改成直连（不再引用代理）之后**代理密码必须还在** —— 那条代理是共享实体，
   * 可能还有别的机器在用。v0.3 的内联版在这里是要清掉密码的（ref 独占），
   * 改成引用之后照抄那个行为就是"改一台机器的代理，把别人的密码删了"。
   */
  it('不引用代理即直连，而那条代理的密码不受影响', async () => {
    const proxy = await startFakeProxy({ kind: 'http' })
    const saved = saveProfile(
      draft({ type: 'http', host: '127.0.0.1', port: proxy.port, password: 'kept' })
    )
    createdProfiles.push(saved.id)
    const ref = getProxy(saved.proxyId!)!.passwordRef!
    expect(vault.getSecret(ref)).toBe('kept')

    const direct = saveProfile({ ...draft(null), id: saved.id })
    expect(direct.proxyId).toBeUndefined()
    expect(vault.getSecret(ref)).toBe('kept')

    await sshManager.open(direct.id)
    expect(proxy.tunnels).toBe(0) // 直连，没经过代理
  })

  it('引用了一条已不存在的代理 —— 报错而不是静默直连', async () => {
    const profile = saveProfile({ ...draft(null), proxyId: 'no-such-proxy' })
    createdProfiles.push(profile.id)
    await expect(sshManager.open(profile.id)).rejects.toThrow(/引用的代理已不存在/)
  })

  it('代理拒绝连接时报代理的错，不误导成 SSH 认证失败', async () => {
    const http = await startFakeProxy({ kind: 'http', refuse: true })
    await expect(openVia({ type: 'http', host: '127.0.0.1', port: http.port })).rejects.toThrow(
      /拒绝建立到 127\.0\.0\.1:2280 的隧道（403 Forbidden）/
    )

    const socks = await startFakeProxy({ kind: 'socks5', refuse: true })
    await expect(openVia({ type: 'socks5', host: '127.0.0.1', port: socks.port })).rejects.toThrow(
      /目标拒绝连接/
    )
  })

  it('代理没起时给出可行动的提示', async () => {
    const dead = await startFakeProxy({ kind: 'socks5' })
    const port = dead.port
    await dead.close()
    openProxies.length = 0
    await expect(openVia({ type: 'socks5', host: '127.0.0.1', port })).rejects.toThrow(
      /代理未启动或端口不对/
    )
  })

  it('引用的代理地址是空的 —— 报错而不是静默直连', async () => {
    const profile = saveProfile(draft({ type: 'socks5', host: '   ', port: 1080 }))
    createdProfiles.push(profile.id)
    // saveProxy 会 trim，所以库里那条的 host 是空串
    expect(getProxy(getProfile(profile.id)!.proxyId!)!.host).toBe('')
    await expect(sshManager.open(profile.id)).rejects.toThrow(/没有填写地址/)
  })

  it('走代理时断线重连仍会重新拨一条隧道', async () => {
    const proxy = await startFakeProxy({ kind: 'socks5' })
    const profile = saveProfile({
      ...draft({ type: 'socks5', host: '127.0.0.1', port: proxy.port }),
      options: {
        keepaliveInterval: 15000,
        readyTimeout: 10000,
        legacyAlgorithms: false,
        autoReconnect: true,
        monitorEnabled: false,
        compress: false
      }
    })
    createdProfiles.push(profile.id)
    const { sessionId } = await sshManager.open(profile.id)
    expect(proxy.tunnels).toBe(1)

    await sshManager.reconnect(sessionId)
    await waitFor(
      () => eventsOf('session:state').filter((e) => e.state === 'ready').length >= 2,
      15000,
      'reconnect ready'
    )
    expect(proxy.tunnels).toBe(2)
    await expect(echoThroughShell(sessionId, 'after-reconnect')).resolves.toContain(
      'after-reconnect'
    )
  })
})
