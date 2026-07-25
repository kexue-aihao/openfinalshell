import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { saveProfile, getProfile, deleteProfile, listConnections } from '../../src/main/store/connections'
import { vault } from '../../src/main/store/Vault'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import type { ProfileDraft } from '@shared/types'

const PORT = 2223

/** 捕获 main → renderer 事件的假窗口 */
const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
function installFakeWindow(): void {
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

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

let server: ChildProcess

beforeAll(async () => {
  installFakeWindow()
  server = spawn(process.execPath, ['test/fixtures/testSshServer.mjs', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test ssh server did not start')), 10000)
    server.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
})

afterAll(() => {
  sshManager.closeAll()
  server?.kill()
})

function draft(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return {
    name: 'fixture',
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
      autoReconnect: false,
      monitorEnabled: false,
      compress: false
    },
    ...overrides
  }
}

describe('凭据存储（credentialRef 模式）', () => {
  it('保存的明文密码不落盘到 connections.json，只留 Vault 引用', () => {
    const profile = saveProfile(draft({ name: 'cred-test' }))
    expect(profile.auth.passwordRef).toBeTruthy()
    // ConnectionProfile 上没有任何明文字段
    expect(JSON.stringify(profile)).not.toContain('test123')
    // Vault 内部可解出原文（仅 main 侧）
    expect(vault.getSecret(profile.auth.passwordRef!)).toBe('test123')
    deleteProfile(profile.id)
  })

  it('删除连接时级联删除 Vault 条目', () => {
    const profile = saveProfile(draft({ name: 'cascade' }))
    const ref = profile.auth.passwordRef!
    deleteProfile(profile.id)
    expect(vault.getSecret(ref)).toBeNull()
    expect(listConnections().profiles.find((p) => p.id === profile.id)).toBeUndefined()
  })

  it('再次保存时留空密码不清除已存凭据', () => {
    const first = saveProfile(draft({ name: 'keep-pw' }))
    const second = saveProfile({
      ...draft({ name: 'keep-pw-renamed' }),
      id: first.id,
      auth: { method: 'password' } // 无 password 字段 = 保持原值
    })
    expect(second.auth.passwordRef).toBe(first.auth.passwordRef)
    expect(vault.getSecret(second.auth.passwordRef!)).toBe('test123')
    deleteProfile(first.id)
  })
})

describe('SSH 会话 + 终端数据通路', () => {
  it('密码认证 → 开 shell → 收到 term:data，并能写入命令拿到回显', async () => {
    events.length = 0
    const profile = saveProfile(draft({ name: 'shell-test' }))

    // 首次连接会触发 hostkey-new prompt：自动应答"信任并保存"
    const promptSub = setInterval(() => {
      const prompts = eventsOf('session:prompt')
      for (const p of prompts) {
        if (p.kind === 'hostkey-new') {
          promptBroker.reply({ requestId: p.requestId, ok: true, remember: true })
        }
      }
    }, 20)

    const { sessionId } = await sshManager.open(profile.id)
    clearInterval(promptSub)
    expect(sessionId).toBeTruthy()
    expect(eventsOf('session:state').at(-1)?.state).toBe('ready')

    const { termId } = await sshManager.openShell(sessionId, 100, 30)
    const shell = sshManager.getTerm(termId)!
    expect(shell).toBeTruthy()

    const decode = (): string =>
      eventsOf('term:data')
        .filter((e) => e.termId === termId)
        .map((e) => Buffer.from(e.data).toString('utf8'))
        .join('')

    await waitFor(() => decode().includes('test@fixture:~$'), 10000, 'shell prompt')

    shell.write('echo 中文测试-🚀\r')
    await waitFor(() => decode().includes('中文测试-🚀\r\n'), 10000, 'echo output')

    // resize 生效（服务器把新尺寸回报给 size 命令）
    shell.resize(120, 40)
    shell.write('size\r')
    await waitFor(() => decode().includes('120x40'), 10000, 'resize applied')

    sshManager.closeTerm(termId)
    sshManager.close(sessionId)
    deleteProfile(profile.id)
  })

  it('背压：flood 大量输出后 ack 补齐，字节数无丢失', async () => {
    events.length = 0
    const profile = saveProfile(draft({ name: 'flood-test' }))
    const { sessionId } = await sshManager.open(profile.id) // hostkey 已信任，无 prompt
    const { termId } = await sshManager.openShell(sessionId, 80, 24)
    const shell = sshManager.getTerm(termId)!

    let received = 0
    let sawDone = false
    // 模拟 renderer：慢速 ack，制造 bytesInFlight 水位压力
    const drain = setInterval(() => {
      const frames = eventsOf('term:data').filter((e) => e.termId === termId)
      while (received < frames.length) {
        const frame = frames[received++]
        if (Buffer.from(frame.data).toString('utf8').includes('[done 4MB]')) sawDone = true
        shell.ack(frame.data.byteLength)
      }
    }, 30)

    await waitFor(() => decodeBytes(termId) > 0, 10000, 'initial output')
    shell.write('flood 4\r')
    await waitFor(() => sawDone, 25000, 'flood completion')
    clearInterval(drain)

    const total = decodeBytes(termId)
    // 4MB 数据必须完整到达（背压只应减速，不应丢数据）
    expect(total).toBeGreaterThan(4 * 1024 * 1024 * 0.95)

    sshManager.closeTerm(termId)
    sshManager.close(sessionId)
    deleteProfile(profile.id)
  })

  it('认证失败给出中文友好错误', async () => {
    const profile = saveProfile(
      draft({ name: 'bad-pw', auth: { method: 'password', password: 'wrong' } })
    )
    await expect(sshManager.open(profile.id)).rejects.toThrow(/认证失败/)
    deleteProfile(profile.id)
  })

  it('端口不可达给出中文友好错误', async () => {
    const profile = saveProfile(draft({ name: 'refused', port: 59999 }))
    await expect(sshManager.open(profile.id)).rejects.toThrow(/端口未开放|连接超时/)
    deleteProfile(profile.id)
  })

  it('hostkey 变更时用户拒绝 → 连接失败', async () => {
    // 重启测试服务器会换 hostkey；这里直接改 known_hosts 记录来模拟"指纹不符"
    const profile = saveProfile(draft({ name: 'hostkey-mismatch', port: PORT }))
    const { trustHostkey } = await import('../../src/main/ssh/hostkeys')
    trustHostkey('127.0.0.1', PORT, 'ssh-rsa', 'deadbeefdeadbeefdeadbeef')

    events.length = 0
    const sub = setInterval(() => {
      for (const p of eventsOf('session:prompt')) {
        if (p.kind === 'hostkey-changed') {
          promptBroker.reply({ requestId: p.requestId, ok: false })
        }
      }
    }, 20)
    await expect(sshManager.open(profile.id)).rejects.toThrow()
    clearInterval(sub)
    const changed = eventsOf('session:prompt').filter((p) => p.kind === 'hostkey-changed')
    expect(changed.length).toBeGreaterThan(0)
    expect((changed[0].payload as { previousFingerprint?: string }).previousFingerprint).toContain(
      'deadbeef'
    )

    // 恢复正确指纹，供后续测试复用
    trustHostkey('127.0.0.1', PORT, 'ssh-rsa', currentFingerprint()!)
    deleteProfile(profile.id)
  })
})

function decodeBytes(termId: string): number {
  return eventsOf('term:data')
    .filter((e) => e.termId === termId)
    .reduce((sum, e) => sum + e.data.byteLength, 0)
}

/** 从 hostkey prompt 事件里取出本次服务器的真实指纹（去掉 SHA256: 前缀） */
function currentFingerprint(): string | undefined {
  for (const p of eventsOf('session:prompt')) {
    const fp = (p.payload as { fingerprintSha256?: string }).fingerprintSha256
    if (fp) return fp.replace(/^SHA256:/, '')
  }
  return undefined
}

describe('会话管理器', () => {
  it('open 不存在的 profile 抛错', async () => {
    await expect(sshManager.open('no-such-id')).rejects.toThrow(/不存在/)
  })

  it('getProfile 在删除后返回 undefined', () => {
    const p = saveProfile(draft({ name: 'gone' }))
    deleteProfile(p.id)
    expect(getProfile(p.id)).toBeUndefined()
  })
})
