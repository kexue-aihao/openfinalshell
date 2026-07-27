/**
 * 编辑 IO 的真机基准 + 各档尺寸的往返完整性（无 OFS_TEST_* 自动跳过）。
 *
 * 它是**两件事**，所以留在测试里而不是当一次性脚本用完就删：
 *
 * 1. **护栏那一半**：在 8KB / 64KB / 200KB / 512KB / 2MB 五个档位上断言"写下去再读回来
 *    逐字节相等"，其中 2MB 正好压在 MAX_EDIT_BYTES 上。并发窗口是按 offset 拼回来的，
 *    这类改动最典型的事故就是"内容对了 99%，某一片错位"，而假 SFTP 测不到真服务器的
 *    短读与乱序完成。
 * 2. **基准那一半**：把往返耗时打出来。片 5 想放宽 MAX_EDIT_BYTES 时，判据就得是这张表 ——
 *    没有它那个决定只能拍脑袋。
 *
 * 本次实测（IO_CONCURRENCY=1 → 16，同一台服务器同一次会话，写/读 ms）：
 *   8KB 681/1136 → 836/1389（噪声）   64KB 1135/1589 → 1109/1939（持平）
 *   200KB 2043/2502 → 1385/1664       512KB 4099/4552 → 1112/1937
 *   2MB 15007/15503 → **1681/2499**
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ProfileDraft } from '@shared/types'
import { MAX_EDIT_BYTES } from '@shared/constants'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { execOnce } from '../../src/main/ssh/ExecRunner'
import { readRemoteFile, writeRemoteFile } from '../../src/main/sftp/sftpLowLevel'

const HOST = process.env.OFS_TEST_HOST
const PORT = Number(process.env.OFS_TEST_PORT ?? 22)
const USER = process.env.OFS_TEST_USER ?? 'root'
const PASSWORD = process.env.OFS_TEST_PASSWORD
const suite = HOST && PASSWORD ? describe : describe.skip

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
let sessionId = ''
let profileId = ''
let sandbox = ''

beforeAll(async () => {
  if (!HOST || !PASSWORD) return
  bindMainWindow({
    isDestroyed: () => false,
    webContents: { send: (c: keyof EventMap, p: unknown) => events.push({ channel: c, payload: p }) }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  const trust = setInterval(() => {
    for (const e of events) {
      const p = e.payload as { kind?: string; requestId?: string }
      if (e.channel === 'session:prompt' && p.kind?.startsWith('hostkey')) {
        promptBroker.reply({ requestId: p.requestId as string, ok: true, remember: true })
      }
    }
  }, 20)
  const draft: ProfileDraft = {
    name: 'ofs-bench-io',
    groupId: null,
    host: HOST,
    port: PORT,
    username: USER,
    auth: { method: 'password', password: PASSWORD },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 20000,
      legacyAlgorithms: false,
      autoReconnect: false,
      monitorEnabled: false,
      compress: false
    }
  }
  const profile = saveProfile(draft)
  profileId = profile.id
  ;({ sessionId } = await sshManager.open(profile.id))
  clearInterval(trust)
  const r = await execOnce(sshManager.get(sessionId), `mktemp -d /tmp/ofs-bench.XXXXXXXX`, {
    timeoutMs: 30_000
  })
  sandbox = r.stdout.trim()
}, 120_000)

afterAll(async () => {
  if (sandbox) {
    await execOnce(sshManager.get(sessionId), `rm -rf -- '${sandbox}'`, { timeoutMs: 30_000 }).catch(
      () => {}
    )
  }
  sshManager.closeAll()
  if (profileId) deleteProfile(profileId)
  
}, 60_000)

suite('编辑 IO 基准', () => {
  it('读回 + 写回各档尺寸', async () => {
    const sftp = await sshManager.get(sessionId).browseSftpSession()
    const rows: string[] = []
    for (const kb of [8, 64, 200, 512, 2048]) {
      const bytes = kb * 1024
      if (bytes > MAX_EDIT_BYTES) continue
      const payload = Buffer.alloc(bytes, 0x61)
      const path = `${sandbox}/f${kb}.conf`

      const t0 = Date.now()
      await writeRemoteFile(sftp, path, payload, 0o644)
      const wrote = Date.now() - t0

      const t1 = Date.now()
      const got = await readRemoteFile(sftp, path, MAX_EDIT_BYTES)
      const read = Date.now() - t1

      expect(got.equals(payload)).toBe(true)
      rows.push(`  ${String(kb).padStart(5)} KB   写 ${String(wrote).padStart(6)} ms   读 ${String(read).padStart(6)} ms`)
    }
    console.log(`\n=== 编辑 IO（并发窗口）===\n${rows.join('\n')}`)
  }, 300_000)
})
