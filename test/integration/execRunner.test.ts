import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ProfileDraft } from '@shared/types'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { buildFastDeleteCommand } from '../../src/main/sftp/fastDelete'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { execOnce } from '../../src/main/ssh/ExecRunner'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { shQuote } from '../../src/main/ssh/shellQuote'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'

/**
 * 唯一目的：把 `SshConnection.execChannel` 这道缝盖上。
 *
 * 单测里 execOnce 喂的是一个假通道，所以"ssh2 真的能开 exec 通道吗、我们那条命令串
 * 经过 SSH 协议之后还是不是同样的字节"两件事没人验过 —— 而**这正是转义唯一会失效的地方**：
 * 传输层只要动了一个字符（补一层引号、按空白重切参数），前面所有精确字符串比对都白搭。
 *
 * fixture 服务器在这里**只当镜子**：把收到的命令原样回显。它没有真 shell 也没有真文件系统，
 * 所以 `rm -rf` 的语义在它上面无法被验证（硬要验就是测试文档警告过的循环论证）——
 * 那些归 test/integration/realServer*.test.ts 和真机验收。
 */

const PORT = 2251
const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
function eventsOf<K extends keyof EventMap>(channel: K): Array<EventMap[K]> {
  return events.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
}

let server: ChildProcess
let sessionId = ''
let profileId = ''

function draft(): ProfileDraft {
  return {
    name: 'exec-fixture',
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
    }
  }
}

/** 镜子回显里夹着的那条命令 */
function mirrored(stdout: string): string {
  const m = /@@FIXTURE:EXEC@@\n([\s\S]*?)\n@@FIXTURE:END@@/.exec(stdout)
  if (!m) throw new Error(`fixture 没有回显命令，实际收到：${JSON.stringify(stdout)}`)
  return m[1]
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
  sshManager.closeAll()
  if (profileId) deleteProfile(profileId)
  server?.kill()
})

describe('execOnce 经过真 SSH 通道', () => {
  it('命令被包成 env … sh -c，且脚本末尾带 RC 哨兵', async () => {
    const conn = sshManager.get(sessionId)
    const result = await execOnce(conn, 'echo hi')
    const command = mirrored(result.stdout)
    expect(command.startsWith("env LC_ALL=C LANG=C sh -c '")).toBe(true)
    expect(command.endsWith("'")).toBe(true)
    expect(command).toContain('echo hi')
    expect(command).toContain('__ofs_rc=$?')
  })

  it('哨兵缺席时退回 exit 事件（fixture 不跑脚本，所以这里量到的就是兜底那条路）', async () => {
    const result = await execOnce(sshManager.get(sessionId), 'echo hi')
    // SSH exit-status 是可选的；fixture 在部分平台只发 close。
    expect(result.code === 0 || result.code === null).toBe(true)
    expect(result.truncated).toBe(false)
  })

  /**
   * 这一条是本文件的重点：一段满是引号、换行、命令替换的脚本，经过
   * `client.exec` → SSH 协议 → 服务端 exec 请求之后必须**一个字节都没变**。
   */
  it('敌意脚本经过传输层逐字节不变', async () => {
    const script = "printf %s '/data/it'\\''s/$(id)/a\\b'\nls -l '中文 名.txt'"
    const command = mirrored((await execOnce(sshManager.get(sessionId), script)).stdout)
    // 整段脚本在外层被引了一次，所以它以"逐字符转义后"的形态原样出现在命令里
    expect(command).toContain(shQuote(script).slice(1, -1))
  })

  it('快速删除那条命令原样到达服务端（引号没有在传输途中被重解释）', async () => {
    const built = buildFastDeleteCommand(['/data/foo', "/data/it's", '/data/$(touch pwned)'])
    const command = mirrored((await execOnce(sshManager.get(sessionId), built)).stdout)
    expect(command).toContain(shQuote(built).slice(1, -1))
    // 转义后的形态里，命令替换仍然被包在引号内（引号外只剩固定词）
    expect(command).toContain("rm -rf --")
  })

  it('会话关了之后开 exec 直接报"会话未就绪"而不是挂住', async () => {
    const conn = sshManager.get(sessionId)
    conn.disconnect()
    await expect(execOnce(conn, 'echo hi')).rejects.toThrow(/会话未就绪/)
  })
})
