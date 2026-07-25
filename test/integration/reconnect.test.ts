import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { monitorManager } from '../../src/main/monitor/MonitorManager'
import { trustHostkey } from '../../src/main/ssh/hostkeys'
import type { ProfileDraft, SessionState } from '@shared/types'

const PORT = 2224

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
function eventsOf<K extends keyof EventMap>(channel: K): Array<EventMap[K]> {
  return events.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
}
function states(): SessionState[] {
  return eventsOf('session:state').map((e) => e.state)
}

async function waitFor(pred: () => boolean, ms = 20000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** 每个用例起一个独立服务器，方便"杀掉服务器"模拟掉线 */
async function startServer(port: number): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ['test/fixtures/testSshServer.mjs', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 10000)
    proc.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  return proc
}

/**
 * 自动应答 hostkey prompt，让测试聚焦于重连行为。
 * 只处理 hostkey-* —— 否则会抢答 password/kbi 提示（无 answers 等于取消）。
 */
function autoTrustHostkeys(): () => void {
  const seen = new Set<string>()
  const iv = setInterval(() => {
    for (const p of eventsOf('session:prompt')) {
      if (seen.has(p.requestId)) continue
      if (p.kind !== 'hostkey-new' && p.kind !== 'hostkey-changed') continue
      seen.add(p.requestId)
      promptBroker.reply({ requestId: p.requestId, ok: true, remember: true })
    }
  }, 20)
  return () => clearInterval(iv)
}

function draft(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return {
    name: 'reconnect-fixture',
    groupId: null,
    host: '127.0.0.1',
    port: PORT,
    username: 'test',
    auth: { method: 'password', password: 'test123' },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 10000,
      legacyAlgorithms: false,
      autoReconnect: true,
      monitorEnabled: false,
      compress: false
    },
    ...overrides
  }
}

let server: ChildProcess | null = null

beforeEach(() => {
  events.length = 0
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
})

afterEach(() => {
  sshManager.closeAll()
  server?.kill()
  server = null
})

describe('断线自动重连', () => {
  it('服务器重启后自动恢复：reconnecting → ready，且旧终端收到 reconnected', async () => {
    server = await startServer(PORT)
    const stop = autoTrustHostkeys()
    const profile = saveProfile(draft())

    const { sessionId } = await sshManager.open(profile.id)
    const { termId } = await sshManager.openShell(sessionId, 80, 24)
    await waitFor(() => eventsOf('term:data').some((e) => e.termId === termId), 10000, 'first output')

    // 杀掉服务器 → 触发掉线；随后重新起服务器让重连成功
    server.kill()
    await waitFor(() => states().includes('reconnecting'), 10000, 'reconnecting state')

    // 旧 shell 应被标记为 reconnected（renderer 据此重开而不是显示"已断开"）
    const exits = eventsOf('term:exit').filter((e) => e.termId === termId)
    expect(exits.length).toBe(1)
    expect(exits[0].reason).toBe('reconnected')

    server = await startServer(PORT)
    // hostkey 每次启动都会变（fixture 现生成），autoTrust 会应答变更提示
    await waitFor(() => states().lastIndexOf('ready') > states().indexOf('reconnecting'), 25000, 'recovered')

    // 恢复后能重新开 shell
    const again = await sshManager.openShell(sessionId, 80, 24)
    expect(again.termId).toBeTruthy()
    expect(again.termId).not.toBe(termId)

    stop()
    deleteProfile(profile.id)
  })

  it('autoReconnect=false 时不重连，直接置 closed', async () => {
    server = await startServer(PORT + 1)
    const stop = autoTrustHostkeys()
    const profile = saveProfile(
      draft({
        name: 'no-retry',
        port: PORT + 1,
        options: {
          keepaliveInterval: 15000,
          readyTimeout: 10000,
          legacyAlgorithms: false,
          autoReconnect: false,
          monitorEnabled: false,
          compress: false
        }
      })
    )
    const { sessionId } = await sshManager.open(profile.id)
    const { termId } = await sshManager.openShell(sessionId, 80, 24)
    await waitFor(() => eventsOf('term:data').some((e) => e.termId === termId), 10000, 'output')

    server.kill()
    await waitFor(() => states().includes('closed'), 10000, 'closed state')
    expect(states()).not.toContain('reconnecting')
    expect(eventsOf('term:exit').find((e) => e.termId === termId)?.reason).toBe('closed')

    stop()
    deleteProfile(profile.id)
  })

  it('会话仍在线时手动重连：不被旧连接的收尾污染成"掉线"', async () => {
    const port = PORT + 6
    server = await startServer(port)
    const stop = autoTrustHostkeys()
    const profile = saveProfile(draft({ name: 'manual-reconnect', port }))

    const { sessionId } = await sshManager.open(profile.id)
    const { termId } = await sshManager.openShell(sessionId, 80, 24)
    await waitFor(() => eventsOf('term:data').some((e) => e.termId === termId), 10000, 'output')

    const before = states().length
    await sshManager.reconnect(sessionId)
    expect(states().at(-1)).toBe('ready')

    // 旧连接的 'close' 是异步到的；退避首档 1s，等过这个窗口才能证明没排重连
    await new Promise((r) => setTimeout(r, 1800))
    const after = states().slice(before)
    expect(after).not.toContain('reconnecting')
    // 一次手动重连只应有一轮 connecting → authenticating → ready
    expect(after.filter((s) => s === 'ready')).toHaveLength(1)
    expect(after.filter((s) => s === 'connecting')).toHaveLength(1)

    // 旧终端必须被告知失效，否则 renderer 会一直握着死掉的 termId 不重开
    const exits = eventsOf('term:exit').filter((e) => e.termId === termId)
    expect(exits).toHaveLength(1)
    expect(exits[0].reason).toBe('reconnected')
    const again = await sshManager.openShell(sessionId, 80, 24)
    expect(again.termId).not.toBe(termId)

    stop()
    deleteProfile(profile.id)
  })

  it('掉线自动重连后监控继续采集（曾经会永久冻在最后一帧）', async () => {
    const port = PORT + 7
    server = await startServer(port)
    const stop = autoTrustHostkeys()
    const profile = saveProfile(draft({ name: 'monitor-reattach', port }))

    const { sessionId } = await sshManager.open(profile.id)
    await monitorManager.start(sessionId, 1000)
    await waitFor(() => eventsOf('monitor:data').length >= 2, 15000, 'first snapshots')

    // 真实掉线：采集通道随连接一起死。旧实现只在通道关闭后重试一次（5s），
    // 停机超过这个窗口时那一次必然落空 → 之后再也不重试，监控永久冻住。
    // 所以这里故意让服务器停够 6.5s，把"侥幸赶上重试"的情况排除掉。
    server.kill()
    await waitFor(() => states().includes('reconnecting'), 10000, 'reconnecting')
    const beforeCount = eventsOf('monitor:data').length
    await new Promise((r) => setTimeout(r, 6500))
    server = await startServer(port)
    await waitFor(
      () => states().lastIndexOf('ready') > states().indexOf('reconnecting'),
      25000,
      'session recovered'
    )

    await waitFor(
      () => eventsOf('monitor:data').length > beforeCount + 1,
      15000,
      'snapshots after reconnect'
    )
    expect(eventsOf('monitor:state').at(-1)?.state).toBe('running')

    monitorManager.stop(sessionId)
    stop()
    deleteProfile(profile.id)
  })

  it('手动重连后监控立刻接回，不用等通道重试的 5 秒', async () => {
    const port = PORT + 8
    server = await startServer(port)
    const stop = autoTrustHostkeys()
    const profile = saveProfile(draft({ name: 'monitor-reattach-fast', port }))

    const { sessionId } = await sshManager.open(profile.id)
    await monitorManager.start(sessionId, 1000)
    await waitFor(() => eventsOf('monitor:data').length >= 2, 15000, 'first snapshots')

    const beforeCount = eventsOf('monitor:data').length
    await sshManager.reconnect(sessionId)
    const at = Date.now()
    await waitFor(
      () => eventsOf('monitor:data').length > beforeCount + 1,
      10000,
      'snapshots after manual reconnect'
    )
    // 走通道自身的 5s 重试才恢复的话这里必然超过
    expect(Date.now() - at).toBeLessThan(4500)

    monitorManager.stop(sessionId)
    stop()
    deleteProfile(profile.id)
  })

  it('用户主动 disconnect 不触发重连', async () => {
    server = await startServer(PORT + 2)
    const stop = autoTrustHostkeys()
    const profile = saveProfile(draft({ name: 'manual-close', port: PORT + 2 }))
    const { sessionId } = await sshManager.open(profile.id)
    await sshManager.openShell(sessionId, 80, 24)

    sshManager.close(sessionId)
    await new Promise((r) => setTimeout(r, 600))
    expect(states()).not.toContain('reconnecting')
    expect(states().at(-1)).toBe('closed')

    stop()
    deleteProfile(profile.id)
  })
})

describe('keyboard-interactive 认证', () => {
  it('kbi-only 账号：用户应答后连接成功', async () => {
    const port = PORT + 3
    server = await startServer(port)
    const stop = autoTrustHostkeys()
    // fixture 的 kbi 账号不接受 password 方法，只走 keyboard-interactive
    const profile = saveProfile(
      draft({ name: 'kbi', port, username: 'kbi', auth: { method: 'password' } })
    )

    // 无已存密码 → 先弹 password prompt（一次性密码），再由服务器发起 kbi
    const answered = new Set<string>()
    const iv = setInterval(() => {
      for (const p of eventsOf('session:prompt')) {
        if (answered.has(p.requestId)) continue
        answered.add(p.requestId)
        if (p.kind === 'password' || p.kind === 'kbi') {
          promptBroker.reply({ requestId: p.requestId, ok: true, answers: ['test123'] })
        }
      }
    }, 20)

    const { sessionId } = await sshManager.open(profile.id)
    clearInterval(iv)
    expect(states().at(-1)).toBe('ready')
    const kinds = eventsOf('session:prompt').map((p) => p.kind)
    expect(kinds).toContain('kbi')

    sshManager.close(sessionId)
    stop()
    deleteProfile(profile.id)
  })

  it('已存密码时单一 password 提示自动应答，不打扰用户', async () => {
    const port = PORT + 4
    server = await startServer(port)
    const stop = autoTrustHostkeys()
    const profile = saveProfile(
      draft({ name: 'kbi-auto', port, username: 'kbi', auth: { method: 'password', password: 'test123' } })
    )

    const { sessionId } = await sshManager.open(profile.id)
    expect(states().at(-1)).toBe('ready')
    // 只应有 hostkey 提示，没有 kbi/password 交互
    const kinds = eventsOf('session:prompt').map((p) => p.kind)
    expect(kinds).not.toContain('kbi')
    expect(kinds).not.toContain('password')

    sshManager.close(sessionId)
    stop()
    deleteProfile(profile.id)
  })
})

describe('hostkey 信任存储', () => {
  it('信任后重连同一 keyType 不再提示', async () => {
    const port = PORT + 5
    server = await startServer(port)
    const stop = autoTrustHostkeys()
    const profile = saveProfile(draft({ name: 'trusted', port }))

    const first = await sshManager.open(profile.id)
    const fp = (
      eventsOf('session:prompt')[0]?.payload as { fingerprintSha256?: string }
    ).fingerprintSha256!.replace(/^SHA256:/, '')
    sshManager.close(first.sessionId)
    trustHostkey('127.0.0.1', port, 'ssh-rsa', fp)

    events.length = 0
    const second = await sshManager.open(profile.id)
    expect(eventsOf('session:prompt')).toHaveLength(0)
    expect(states().at(-1)).toBe('ready')

    sshManager.close(second.sessionId)
    stop()
    deleteProfile(profile.id)
  })
})
