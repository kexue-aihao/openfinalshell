import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
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
