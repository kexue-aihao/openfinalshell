/**
 * `MaxSessions` 很小的服务器上，通道开不出来时给用户的是**人能懂的话**还是 ssh2 的原话。
 *
 * 这条以前记在计划的"人工验证"一栏（"低配服务器（MaxSessions 2）下监控拿不到通道时
 * 显示通道不足而不是报错"），于是一直没人验 —— 手头没有那样的服务器，改一台生产机的
 * sshd 配置又不是测试该做的事。把封顶放进 fixture（OFS_FIXTURE_MAX_SESSIONS）之后
 * 它就是一条普通的自动化用例了。
 *
 * 第一次跑就抓到了真东西：`channelOpenError()` 是专为这件事写的，全项目却只有
 * `execChannel()` 一处在用，`openShell` / `openMonitorChannel` / `browseSftpSession` /
 * `acquireTransferSftp` 四处都还在用 `friendlySshError()` —— 而它的正则一条都不匹配
 * "(SSH) Channel open failure: open failed"，于是原话直接透给用户。
 * README 里那句"MaxSessions 很小的服务器上可能报『服务器拒绝新建通道』"当时是假的。
 *
 * 每个用例各开一条**新会话**：MaxSessions 是 per-connection 的，各自一份预算，
 * 用例之间因此不互相污染，顺序也无关。
 *
 * 覆盖不到的一处，说清楚：`acquireTransferSftp()` 开在**第二条 TCP 连接**上，
 * 而 SFTP 子系统是那条连接上的第一个通道 —— 只要连接建得起来，这个通道就一定开得出来，
 * 没有办法在它之前把那条连接的通道占满。它的文案一并改成 channelOpenError，
 * 但**没有**行为用例，别以为这里全覆盖了。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ProfileDraft, SessionId } from '@shared/types'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { monitorManager } from '../../src/main/monitor/MonitorManager'

const PORT = 2252
const MAX_SESSIONS = 2

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
let server: ChildProcess
let profileId = ''

function draft(): ProfileDraft {
  return {
    name: 'max-sessions-fixture',
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
      monitorEnabled: true,
      compress: false
    }
  }
}

/** 开一条新会话（首连会问 host key，这里一律信任并记住） */
async function openSession(): Promise<SessionId> {
  const trust = setInterval(() => {
    for (const e of events) {
      const p = e.payload as { kind?: string; requestId?: string }
      if (e.channel === 'session:prompt' && p.kind?.startsWith('hostkey')) {
        promptBroker.reply({ requestId: p.requestId as string, ok: true, remember: true })
      }
    }
  }, 20)
  try {
    const { sessionId } = await sshManager.open(profileId)
    return sessionId
  } finally {
    clearInterval(trust)
  }
}

/**
 * 取一次**必然失败**的调用的报错文案。
 *
 * 成功时抛而不是返回空串：不然"通道其实开出来了"会被后面的断言当成"文案不对"，
 * 把一个断言写反的假红和一个真实的行为变化混成同一条错误信息。
 */
async function messageOf(call: Promise<unknown>, where: string): Promise<string> {
  try {
    await call
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error(`${where} 本该因为通道用满而失败，却成功了 —— 这条用例证明不了任何事`)
}

/**
 * 一条被拒的通道该长什么样：既要点出"是通道数用满了"，又不能把 ssh2 的原话透出去。
 *
 * 两个断言都必要。只断言"包含 MaxSessions"的话，把原话拼在友好文案后面也算过；
 * 只断言"不含 open failed"的话，返回一个空串也算过。
 */
function expectFriendlyChannelError(msg: string, where: string): void {
  expect(msg, `${where}：文案里没有点出通道数用满`).toMatch(/拒绝新建通道|MaxSessions/)
  expect(msg, `${where}：ssh2 的原话漏给了用户`).not.toMatch(/open fail(ure|ed)/i)
}

beforeAll(async () => {
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  server = spawn(process.execPath, ['test/fixtures/testSshServer.mjs', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OFS_FIXTURE_MAX_SESSIONS: String(MAX_SESSIONS) }
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture 启动超时')), 10000)
    server.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  profileId = saveProfile(draft()).id
}, 30_000)

afterEach(() => {
  monitorManager.stopAll()
  sshManager.closeAll()
})

afterAll(() => {
  if (profileId) deleteProfile(profileId)
  server?.kill()
})

describe(`MaxSessions=${MAX_SESSIONS} 的服务器`, () => {
  it('第 3 个终端标签：开不出来时说的是通道不足，不是 ssh2 原话', async () => {
    const sessionId = await openSession()
    const conn = sshManager.get(sessionId)

    // 反空转：前两条必须真的开出来，否则下面那次失败可能压根与通道预算无关
    await conn.openShell(80, 24)
    await conn.openShell(80, 24)

    expectFriendlyChannelError(await messageOf(conn.openShell(80, 24), '第 3 个 shell'), 'openShell')
  }, 30_000)

  it('shell + 监控占满 2 条后，浏览 SFTP 说的是通道不足', async () => {
    const sessionId = await openSession()
    const conn = sshManager.get(sessionId)

    await conn.openShell(80, 24)
    // 监控确实拿到了第 2 条通道 —— 这同时证明 fixture 的封顶没有低到 1
    await monitorManager.start(sessionId)

    const msg = await messageOf(conn.browseSftpSession(), '第 3 条通道（浏览 SFTP）')
    expectFriendlyChannelError(msg, 'browseSftpSession')
  }, 30_000)

  it('shell + 浏览 SFTP 占满 2 条后，监控说的是通道不足', async () => {
    const sessionId = await openSession()
    const conn = sshManager.get(sessionId)

    await conn.openShell(80, 24)
    await conn.browseSftpSession()

    // monitor:start 的失败要一路冒到 IPC 调用方（渲染进程据此把面板打成 failed 并显示这句话）
    const msg = await messageOf(monitorManager.start(sessionId), '第 3 条通道（监控）')
    expectFriendlyChannelError(msg, 'openMonitorChannel')
  }, 30_000)

  it('关掉一个终端就腾出一格（拒绝不是一次性的闸门）', async () => {
    const sessionId = await openSession()
    const conn = sshManager.get(sessionId)

    const first = await conn.openShell(80, 24)
    await conn.openShell(80, 24)
    await expect(conn.browseSftpSession()).rejects.toThrow(/拒绝新建通道|MaxSessions/)

    first.close()
    // 通道关闭要一个来回才在服务器侧计数上生效
    await new Promise((r) => setTimeout(r, 600))
    await expect(conn.browseSftpSession()).resolves.toBeTruthy()
  }, 30_000)
})
