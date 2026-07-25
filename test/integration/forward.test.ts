import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, connect, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ForwardRule, ProfileDraft } from '@shared/types'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { forwardManager } from '../../src/main/forward/ForwardManager'

const SSH_PORT = 2260
const ECHO_PORT = 2261 // 被转发的目标服务（大写回显）
const LOCAL_PORT = 2262 // -L 本地监听
const SOCKS_PORT = 2263 // 动态转发监听
const REMOTE_PORT = 2264 // -R 远端监听
const LOCAL_TARGET_PORT = 2265 // -R 回连的本地目标

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
function eventsOf<K extends keyof EventMap>(channel: K): Array<EventMap[K]> {
  return events.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
}

let server: ChildProcess
let echoServer: Server
let localTarget: Server
let sessionId = ''
let profileId = ''

/** 起一个把输入转大写回显的 TCP 服务，用来验证隧道确实通了 */
function startEchoServer(port: number, prefix: string): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer((socket) => {
      socket.on('data', (chunk) => socket.write(`${prefix}:${chunk.toString('utf8').toUpperCase()}`))
    })
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

/** 直连端口：发一行文本收第一条回复 */
function roundtrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload))
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`roundtrip timeout on ${port}`))
    }, 8000)
    socket.on('data', (chunk) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(chunk.toString('utf8'))
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * 走 SOCKS5 代理的往返：握手(回 2B) → CONNECT(回 10B) → 载荷。
 * 按字节数消费应答，不假设 TCP 分段边界。
 */
function socksRoundtrip(
  proxyPort: number,
  target: { host: string; port: number },
  payload: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1', () =>
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
    )
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`socks roundtrip timeout on ${proxyPort}`))
    }, 8000)

    let buf = Buffer.alloc(0)
    let phase: 'greeting' | 'reply' | 'payload' = 'greeting'
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (phase === 'greeting') {
        if (buf.length < 2) return
        if (buf[1] !== 0x00) {
          clearTimeout(timer)
          socket.destroy()
          reject(new Error(`greeting rejected: ${buf[1]}`))
          return
        }
        buf = buf.subarray(2)
        phase = 'reply'
        const octets = target.host.split('.').map(Number)
        socket.write(
          Buffer.from([
            0x05,
            0x01,
            0x00,
            0x01,
            ...octets,
            (target.port >> 8) & 0xff,
            target.port & 0xff
          ])
        )
      }
      if (phase === 'reply') {
        if (buf.length < 10) return
        if (buf[1] !== 0x00) {
          clearTimeout(timer)
          socket.destroy()
          reject(new Error(`connect rejected: rep=${buf[1]}`))
          return
        }
        buf = buf.subarray(10)
        phase = 'payload'
        socket.write(payload)
      }
      if (phase === 'payload' && buf.length > 0) {
        clearTimeout(timer)
        const text = buf.toString('utf8')
        socket.destroy()
        resolve(text)
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function draft(): ProfileDraft {
  return {
    name: 'forward-fixture',
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
    }
  }
}

function rule(overrides: Partial<ForwardRule>): ForwardRule {
  return {
    id: crypto.randomUUID(),
    profileId,
    type: 'local',
    label: 'test rule',
    bindAddr: '127.0.0.1',
    bindPort: LOCAL_PORT,
    autoStart: false,
    ...overrides
  }
}

beforeAll(async () => {
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  echoServer = await startEchoServer(ECHO_PORT, 'REMOTE')
  localTarget = await startEchoServer(LOCAL_TARGET_PORT, 'LOCAL')

  server = spawn(process.execPath, ['test/fixtures/testSshServer.mjs', String(SSH_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 10000)
    server.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  const trust = setInterval(() => {
    for (const p of eventsOf('session:prompt')) {
      if (p.kind === 'hostkey-new' || p.kind === 'hostkey-changed') {
        promptBroker.reply({ requestId: p.requestId, ok: true, remember: true })
      }
    }
  }, 20)
  const profile = saveProfile(draft())
  profileId = profile.id
  ;({ sessionId } = await sshManager.open(profile.id))
  clearInterval(trust)
})

afterAll(() => {
  forwardManager.stopAll()
  sshManager.closeAll()
  if (profileId) deleteProfile(profileId)
  echoServer?.close()
  localTarget?.close()
  server?.kill()
})

describe('本地转发 (-L)', () => {
  it('本地端口的数据经 SSH 到达远端目标', async () => {
    const r = rule({ type: 'local', bindPort: LOCAL_PORT, dstHost: '127.0.0.1', dstPort: ECHO_PORT })
    await forwardManager.start(r, sessionId)
    expect(forwardManager.runtimeOf(r.id)?.state).toBe('active')

    const reply = await roundtrip(LOCAL_PORT, 'hello')
    expect(reply).toBe('REMOTE:HELLO')

    // 连接计数与流量统计
    const runtime = forwardManager.runtimeOf(r.id)!
    expect(runtime.totalBytes).toBeGreaterThan(0)
    forwardManager.stop(r.id)
    expect(forwardManager.runtimeOf(r.id)).toBeUndefined()
  })

  it('停止后端口不再监听', async () => {
    await expect(roundtrip(LOCAL_PORT, 'hello')).rejects.toThrow()
  })

  it('端口被占用时报中文错误', async () => {
    const blocker = await startEchoServer(LOCAL_PORT + 20, 'X')
    const r = rule({
      type: 'local',
      bindPort: LOCAL_PORT + 20,
      dstHost: '127.0.0.1',
      dstPort: ECHO_PORT
    })
    await expect(forwardManager.start(r, sessionId)).rejects.toThrow(/端口已被占用/)
    blocker.close()
  })
})

describe('动态转发 (SOCKS5)', () => {
  it('浏览器风格的 SOCKS5 CONNECT 能打通隧道', async () => {
    const r = rule({ type: 'dynamic', bindPort: SOCKS_PORT })
    await forwardManager.start(r, sessionId)
    expect(forwardManager.runtimeOf(r.id)?.state).toBe('active')

    const reply = await socksRoundtrip(SOCKS_PORT, { host: '127.0.0.1', port: ECHO_PORT }, 'socks')
    expect(reply).toBe('REMOTE:SOCKS')
    forwardManager.stop(r.id)
  })

  it('不支持的命令（BIND）被拒绝而不崩溃', async () => {
    const r = rule({ type: 'dynamic', bindPort: SOCKS_PORT + 20 })
    await forwardManager.start(r, sessionId)
    const got = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(SOCKS_PORT + 20, '127.0.0.1', () => {
        socket.write(Buffer.from([0x05, 0x01, 0x00]))
      })
      const chunks: Buffer[] = []
      socket.on('data', (c) => {
        chunks.push(c)
        if (chunks.length === 1) socket.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0, 80]))
        else {
          socket.destroy()
          resolve(Buffer.concat(chunks))
        }
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('timeout')), 6000)
    })
    // 第 2 段是 10 字节应答，REP=0x07 command not supported
    expect(got.at(-9)).toBe(0x07)
    expect(forwardManager.runtimeOf(r.id)?.state).toBe('active')
    forwardManager.stop(r.id)
  })
})

describe('远程转发 (-R)', () => {
  it('远端监听的连接回推到本地目标', async () => {
    const r = rule({
      type: 'remote',
      bindPort: REMOTE_PORT,
      dstHost: '127.0.0.1',
      dstPort: LOCAL_TARGET_PORT
    })
    await forwardManager.start(r, sessionId)
    expect(forwardManager.runtimeOf(r.id)?.state).toBe('active')

    // fixture 在服务器侧真的监听了 REMOTE_PORT
    const reply = await roundtrip(REMOTE_PORT, 'reverse')
    expect(reply).toBe('LOCAL:REVERSE')
    forwardManager.stop(r.id)
  })
})

describe('生命周期', () => {
  it('会话关闭时规则一并停止', async () => {
    const r = rule({ type: 'local', bindPort: LOCAL_PORT + 40, dstHost: '127.0.0.1', dstPort: ECHO_PORT })
    await forwardManager.start(r, sessionId)
    expect(forwardManager.runtimeOf(r.id)?.state).toBe('active')

    forwardManager.stopForSession(sessionId)
    expect(forwardManager.runtimeOf(r.id)).toBeUndefined()
    await expect(roundtrip(LOCAL_PORT + 40, 'x')).rejects.toThrow()
  })

  it('onSessionLost 把规则标记为 error 并返回待恢复列表', async () => {
    const r = rule({ type: 'local', bindPort: LOCAL_PORT + 41, dstHost: '127.0.0.1', dstPort: ECHO_PORT })
    await forwardManager.start(r, sessionId)
    events.length = 0
    const lost = forwardManager.onSessionLost(sessionId)
    expect(lost.map((x) => x.id)).toContain(r.id)
    const states = eventsOf('forward:state').map((e) => e.runtime)
    expect(states.some((s) => s.forwardId === r.id && s.state === 'error')).toBe(true)
  })
})
