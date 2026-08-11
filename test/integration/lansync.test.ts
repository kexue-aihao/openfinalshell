import { connect } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { database, prepare } from '../../src/main/store/Database'
import * as conns from '../../src/main/store/connections'
import { patchSettings } from '../../src/main/services/settings'
import { lanSyncManager } from '../../src/main/lansync/LanSyncManager'
import { encodeFrame, type SyncFrame } from '../../src/main/lansync/protocol'
import { createEcdhPair } from '../../src/main/lansync/pairing'

/**
 * 局域网同步的端到端。收发两端在同一进程里实例化（真 TCP 过 127.0.0.1 回环）——
 * 不需要 spawn 子进程，lanSyncManager 的收会话与发会话是两份独立状态，互不干扰。
 *
 * 盯的都是 grep 护栏读不出的运行时行为：正常链路的状态序列与落库、错码烧码、
 * 单飞行 busy、垃圾流量不烧码、超长帧断连。组播发现路径归真机冒烟（回环组播在
 * CI 上不稳定），这里只验单播 probe→announce 那一跳能通。
 */

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []

function seed(): string {
  for (const tbl of ['profiles', 'conn_groups', 'secrets', 'snippets', 'snippet_groups', 'forwards', 'known_hosts', 'proxies', 'private_keys']) {
    prepare(`DELETE FROM ${tbl}`).run()
  }
  return conns.saveProfile({
    name: 'lan-seed',
    groupId: null,
    host: '10.9.8.7',
    port: 2222,
    username: 'root',
    auth: { method: 'password', password: 'p@ss-🔐' },
    terminal: { charset: 'utf-8', termType: 'xterm' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 20000,
      legacyAlgorithms: false,
      autoReconnect: true,
      monitorEnabled: true,
      compress: false
    }
  }).id
}

/** 轮询等待某个条件（状态经事件异步推来） */
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('waitFor timeout')
}

/** 裸 TCP 连一条帧过去，用来伪造攻击流量 */
function rawConnect(port: number): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => resolve(s))
    s.on('error', reject)
  })
}

beforeAll(() => {
  database()
  patchSettings({ language: 'zh-CN' }) // 固定语言，错误文案断言不受运行顺序影响
  bindMainWindow({
    isDestroyed: () => false,
    webContents: { send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload }) }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
})

afterEach(() => {
  lanSyncManager.stopAll()
  events.length = 0
})

afterAll(() => {
  lanSyncManager.stopAll()
})

describe('局域网同步：正常链路', () => {
  it('发送方用正确配对码 → 接收方落库、双方状态序列走到底、计数对得上', async () => {
    const profileId = seed()
    const recv = await lanSyncManager.startReceive()
    expect(recv.phase).toBe('waiting')
    expect(recv.code).toMatch(/^\d{6}$/)
    const port = recv.tcpPort!

    // 清空库：验证这条连接确实是"传过来又写回去"的
    prepare('DELETE FROM profiles').run()
    expect(conns.getProfile(profileId)).toBeUndefined()
    // 但发送方发的是发送时的库——所以重新 seed 再发
    const sendId = seed()

    await lanSyncManager.send({ target: { host: '127.0.0.1', port }, code: recv.code!, includeSecrets: true })

    // send() resolve 于 delivered；此刻接收端应已进入 incoming 且拿到真实计数
    await waitFor(() => lanSyncManager.receiveStatus().phase === 'incoming')
    const preview = lanSyncManager.receiveStatus().preview!
    expect(preview.source).toBe('lan')
    expect(preview.counts.profiles).toBe(1)

    // 清库后应用，确认真的写回
    prepare('DELETE FROM profiles').run()
    const result = await lanSyncManager.applyIncoming({
      token: preview.token,
      conflict: 'overwrite',
      include: { profiles: true, snippets: true, forwards: true, knownHosts: true, settings: false }
    })
    expect(result.profiles).toBe(1)
    expect(conns.getProfile(sendId)?.host).toBe('10.9.8.7')

    // 接收端 done、发送端拿到 applied 回执
    expect(lanSyncManager.receiveStatus().phase).toBe('done')
    await waitFor(() => {
      const s = events.filter((e) => e.channel === 'sync:sendState').map((e) => e.payload as { phase: string })
      return s.some((x) => x.phase === 'applied')
    })

    // 发送端收到 applied 后会关连接；接收端不能因这次 close 把 done 回滚成 waiting
    // （否则导入结果摘要被冲掉，用户看不到）。多等一会儿确认 done 稳住
    await new Promise((r) => setTimeout(r, 150))
    expect(lanSyncManager.receiveStatus().phase, 'done 被发送端断开回滚了').toBe('done')
  })

  it('取消发送会结算 send() 的 Promise（不让 sync:send 的 IPC 永久挂起）', async () => {
    seed()
    const recv = await lanSyncManager.startReceive()
    const port = recv.tcpPort!
    // 发起后立刻取消（此刻还在 connecting/confirming，远未 delivered）
    const p = lanSyncManager.send({ target: { host: '127.0.0.1', port }, code: recv.code!, includeSecrets: false })
    lanSyncManager.cancelSend()
    // send() 必须结算（resolve 或 reject），绝不能挂起——挂起就是泄漏一个永不回复的 IPC
    const outcome = await Promise.race([
      p.then(() => 'settled', () => 'settled'),
      new Promise<string>((r) => setTimeout(() => r('hung'), 2000))
    ])
    expect(outcome, 'send() 的 Promise 在取消后永久挂起').toBe('settled')
  })
})

describe('局域网同步：错码烧码', () => {
  it('错误配对码 → 发送方报码错、接收方立即换新码、旧码再试必败', async () => {
    seed()
    const recv = await lanSyncManager.startReceive()
    const port = recv.tcpPort!
    const oldCode = recv.code!

    await expect(
      lanSyncManager.send({ target: { host: '127.0.0.1', port }, code: '000000', includeSecrets: false })
    ).rejects.toThrow(/配对码不正确/)

    // 接收端已烧码换新
    await waitFor(() => {
      const c = lanSyncManager.receiveStatus().code
      return !!c && c !== oldCode
    })
    // 用旧码再发必败（它已经不是当前码了）
    await expect(
      lanSyncManager.send({ target: { host: '127.0.0.1', port }, code: oldCode, includeSecrets: false })
    ).rejects.toThrow(/配对码不正确/)
  })
})

describe('局域网同步：单飞行与垃圾流量', () => {
  it('握手进行中第二条连入收到 busy 错误帧', async () => {
    seed()
    const recv = await lanSyncManager.startReceive()
    const port = recv.tcpPort!

    // 第一条：发一个**合法**的 hello 占住飞行位（合法公钥才能过 derivePairKey，握手会停在
    // 等 confirm-s，连接与单飞行槽都被持住）。用坏公钥会被立刻断连、反而释放槽
    const first = await rawConnect(port)
    first.write(
      encodeFrame({
        kind: 'hello',
        magic: 'OFSSYNC1',
        proto: 1,
        deviceId: 'x',
        deviceName: 'X',
        appVersion: '0.0.0',
        senderPub: createEcdhPair().publicDer.toString('base64')
      })
    )
    await waitFor(() => lanSyncManager.receiveStatus().phase === 'handshake')

    // 第二条连入应当收到 busy 错误帧
    const second = await rawConnect(port)
    const frame = await new Promise<SyncFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no busy frame')), 3000)
      second.on('data', (buf) => {
        clearTimeout(timer)
        resolve(JSON.parse(buf.subarray(4).toString('utf8')))
      })
    })
    expect(frame).toMatchObject({ kind: 'error', code: 'err.sync.busy' })
    first.destroy()
    second.destroy()
  })

  it('hello flood 防线：同一连接的第二个 hello 被幂等守卫挡下（协议错误 + 断连）', async () => {
    seed()
    const recv = await lanSyncManager.startReceive()
    const port = recv.tcpPort!

    // 攻击者在一条连接里连发多个合法 hello。这是 pre-auth DoS 的放大器：旧实现对每个 hello
    // 都跑一次 scrypt（且同步阻塞主线程）。守卫的语义是"每连接只认首个 hello"——第二个起
    // 一律按协议错误断连，攻击者无法用重复 hello 触发多次 scrypt。
    const attacker = await rawConnect(port)
    const pub = createEcdhPair().publicDer.toString('base64')
    const hello = (): Buffer =>
      encodeFrame({
        kind: 'hello',
        magic: 'OFSSYNC1',
        proto: 1,
        deviceId: 'flood',
        deviceName: 'F',
        appVersion: '0.0.0',
        senderPub: pub
      })

    // 收集收到的帧；期待先来一个合法 hello-ack（首个 hello 的响应），再来一个 error（第二个被拒）
    const frames: SyncFrame[] = []
    const reader = new (await import('../../src/main/lansync/protocol')).FrameReader((f) => frames.push(f))
    attacker.on('data', (b) => reader.feed(b))
    const closed = new Promise<void>((resolve) => attacker.on('close', () => resolve()))

    // 一次性发两个 hello（第二个必须被守卫拒）
    attacker.write(Buffer.concat([hello(), hello()]))
    await closed // 守卫会断开这条连接

    expect(frames.some((f) => f.kind === 'error' && f.code === 'err.sync.protocol'), '第二个 hello 未被幂等守卫拒').toBe(true)
    // 而且这次会话没走到 confirm——攻击者拿一堆 hello 推进不了状态
    expect(lanSyncManager.receiveStatus().phase).not.toBe('receiving')
  })

  it('confirm 之前的垃圾流量不烧码（端口扫描器不该逼用户重读码）', async () => {
    seed()
    const recv = await lanSyncManager.startReceive()
    const port = recv.tcpPort!
    const code = recv.code!

    // 连上发一堆乱字节（不成帧）→ 接收端断连，但码不变
    const junk = await rawConnect(port)
    junk.write(Buffer.from('garbage not a frame at all'))
    await new Promise((r) => setTimeout(r, 300))
    junk.destroy()
    await new Promise((r) => setTimeout(r, 200))
    expect(lanSyncManager.receiveStatus().code).toBe(code)
  })

  it('超长帧前缀 → 连接被断，进程不被撑爆', async () => {
    seed()
    const recv = await lanSyncManager.startReceive()
    const port = recv.tcpPort!
    const code = recv.code!

    const evil = await rawConnect(port)
    const head = Buffer.allocUnsafe(4)
    head.writeUInt32BE(100 * 1024 * 1024, 0) // 声称 100MiB
    const closed = new Promise<void>((resolve) => evil.on('close', () => resolve()))
    evil.write(head)
    await closed // 接收端读到非法长度即断
    // confirm 之前，码不烧
    await new Promise((r) => setTimeout(r, 100))
    expect(lanSyncManager.receiveStatus().code).toBe(code)
  })
})
