/**
 * 经真实代理连真实服务器（默认跳过）。
 *
 * proxyConnect.test.ts 用的是本进程起的假代理，能证明协议编码正确；
 * 这套连真实代理软件（Clash / v2ray / Shadowsocks 的混合端口等），
 * 覆盖假代理模拟不了的部分：真实代理的分段行为、DNS 由谁解析、隧道内的完整 SSH 会话。
 *
 * 凭据与代理都只从环境变量读，不写进代码库：
 *   $env:OFS_TEST_HOST='1.2.3.4'; $env:OFS_TEST_PORT='22'
 *   $env:OFS_TEST_USER='root';    $env:OFS_TEST_PASSWORD='...'
 *   $env:OFS_TEST_PROXY_HOST='127.0.0.1'; $env:OFS_TEST_PROXY_PORT='7897'
 *   # 只支持其中一种协议时，用 OFS_TEST_PROXY_KINDS='socks5' 缩小范围
 *   npx vitest run test/integration/realServerProxy.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ProfileDraft, ProxyType } from '@shared/types'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { saveProxy } from '../../src/main/store/savedRefs'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { readdir } from '../../src/main/sftp/SftpManager'

const HOST = process.env.OFS_TEST_HOST
const PORT = Number(process.env.OFS_TEST_PORT ?? 22)
const USER = process.env.OFS_TEST_USER ?? 'root'
const PASSWORD = process.env.OFS_TEST_PASSWORD
const PROXY_HOST = process.env.OFS_TEST_PROXY_HOST
const PROXY_PORT = Number(process.env.OFS_TEST_PROXY_PORT ?? 0)
const PROXY_USER = process.env.OFS_TEST_PROXY_USER
const PROXY_PASSWORD = process.env.OFS_TEST_PROXY_PASSWORD
const KINDS = (process.env.OFS_TEST_PROXY_KINDS ?? 'http,socks5')
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is Exclude<ProxyType, 'none'> => s === 'http' || s === 'socks5')

const enabled = Boolean(HOST && PASSWORD && PROXY_HOST && PROXY_PORT)
const suite = enabled ? describe : describe.skip

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
function eventsOf<K extends keyof EventMap>(channel: K): Array<EventMap[K]> {
  return events.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
}
async function waitFor(pred: () => boolean, ms = 30000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const observed: Record<string, string> = {}
const createdProfiles: string[] = []
let autoTrust: ReturnType<typeof setInterval>

beforeAll(() => {
  if (!enabled) return
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  autoTrust = setInterval(() => {
    for (const p of eventsOf('session:prompt')) {
      if (p.kind === 'hostkey-new' || p.kind === 'hostkey-changed') {
        promptBroker.reply({ requestId: p.requestId, ok: true, remember: true })
      }
    }
  }, 20)
})

afterAll(() => {
  if (!enabled) return
  clearInterval(autoTrust)
  sshManager.closeAll()
  for (const id of createdProfiles.splice(0)) deleteProfile(id)
  console.log('\n===== 经代理连接观测结果 =====')
  for (const [k, v] of Object.entries(observed)) console.log(`${k}: ${v}`)
  console.log('=============================\n')
})

function draft(type: Exclude<ProxyType, 'none'>): ProfileDraft {
  return {
    name: `real-via-${type}`,
    groupId: null,
    host: HOST!,
    port: PORT,
    username: USER,
    auth: { method: 'password', password: PASSWORD },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 30000,
      legacyAlgorithms: false,
      autoReconnect: false,
      monitorEnabled: false,
      compress: false
    },
    // 代理是可复用实体：每条用例存一条，连接只引用 id
    proxyId: saveProxy({
      name: `acc-${type}-${PROXY_PORT}`,
      type,
      host: PROXY_HOST!,
      port: PROXY_PORT,
      username: PROXY_USER,
      password: PROXY_PASSWORD
    }).id
  }
}

suite('经真实代理连真实服务器', () => {
  for (const kind of KINDS) {
    it(`${kind} 代理：握手、shell 中文回显、隧道内 SFTP`, async () => {
      const profile = saveProfile(draft(kind))
      createdProfiles.push(profile.id)

      const started = Date.now()
      const { sessionId } = await sshManager.open(profile.id)
      observed[`${kind}_握手耗时`] = `${Date.now() - started}ms`
      expect(eventsOf('session:state').at(-1)?.state).toBe('ready')

      const conn = sshManager.get(sessionId)
      const shell = await conn.openShell(80, 24)
      let out = ''
      const collect = setInterval(() => {
        for (const e of eventsOf('term:data')) {
          if (e.termId === shell.termId) out += Buffer.from(e.data).toString('utf8')
        }
      }, 20)
      const token = `经${kind}代理-中文-🚀`
      shell.write(`echo ${token}\n`)
      try {
        await waitFor(() => out.includes(token), 30000, `${kind} shell echo`)
      } finally {
        clearInterval(collect)
      }
      expect(out).toContain(token)

      // 隧道里跑 SFTP 子系统（不只是握手能过）
      const entries = await readdir(sessionId, '/')
      expect(entries.some((e) => e.name === 'etc' && e.type === 'dir')).toBe(true)
      observed[`${kind}_根目录条目数`] = String(entries.length)

      shell.close()
      sshManager.close(sessionId)
      observed[`${kind}_结果`] = 'ok'
    }, 90000)
  }

  it('代理端口填错时报的是代理的错，不会误导成服务器问题', async () => {
    // 借一个必定没人监听的端口（同机 +1 万一撞上就换）
    const badPort = PROXY_PORT === 65535 ? 65534 : PROXY_PORT + 1
    const profile = saveProfile({
      ...draft(KINDS[0] ?? 'socks5'),
      name: 'real-via-bad-proxy',
      proxyId: saveProxy({
        name: 'acc-bad-proxy',
        type: KINDS[0] ?? 'socks5',
        host: PROXY_HOST!,
        port: badPort
      }).id
    })
    createdProfiles.push(profile.id)
    await expect(sshManager.open(profile.id)).rejects.toThrow(
      /代理未启动或端口不对|无法连接.*代理/
    )
  }, 60000)
})
