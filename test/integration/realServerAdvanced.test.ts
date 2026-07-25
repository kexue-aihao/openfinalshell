/**
 * 真实服务器进阶验收（默认跳过）——覆盖第一组之外、需要额外动作的验证项。
 *
 * 环境变量同 realServer.test.ts。额外的服务器改动都在用例内自行清理：
 *  - 私钥认证：临时生成 ed25519 密钥对，公钥追加到 authorized_keys（先备份），验完精确删除该行
 *  - 非 UTF-8 文件名：在 /tmp 建 GBK 文件名的文件，验完删除
 *  - 大文件传输：在 /tmp 生成测试文件，验完删除
 * GBK 终端转码与断线重连不改服务器任何东西。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ProfileDraft, SessionState } from '@shared/types'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { patchSettings } from '../../src/main/services/settings'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { readdir, remove } from '../../src/main/sftp/SftpManager'
import { transferQueue } from '../../src/main/sftp/TransferQueue'

const HOST = process.env.OFS_TEST_HOST
const PORT = Number(process.env.OFS_TEST_PORT ?? 22)
const USER = process.env.OFS_TEST_USER ?? 'root'
const PASSWORD = process.env.OFS_TEST_PASSWORD
/**
 * 大文件测试的体积。默认 20MB：下载吞吐取决于服务器出口带宽，
 * 慢链路（实测有 0.1MB/s 的）上 200MB 会跑到测试超时。要压测大文件自行调大并同步放宽超时。
 */
const BIG_FILE_MB = Number(process.env.OFS_TEST_BIG_MB ?? 20)

const enabled = Boolean(HOST && PASSWORD)
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
let baseSessionId = ''
let basePasswordProfileId = ''
let localDir = ''
/** 需要在 afterAll 兜底清理的远端路径 */
const remoteCleanup: string[] = []
/** 记录是否动过 authorized_keys，兜底恢复 */
let authorizedKeysTouched = false
/** 测试开始前 authorized_keys 是否已存在 —— 决定清理时是"恢复内容"还是"整个删掉" */
let authorizedKeysPreexisted = false
let pubKeyLine = ''

/**
 * 把 authorized_keys 恢复到测试前的状态：
 * 原本不存在 → 整个删掉；原本存在 → 从备份恢复。并清掉所有中间文件，不留痕迹。
 */
async function restoreAuthorizedKeys(): Promise<string> {
  if (!authorizedKeysTouched) return '未改动'
  const cmd = authorizedKeysPreexisted
    ? 'if [ -f ~/.ssh/authorized_keys.ofs-backup ]; then mv -f ~/.ssh/authorized_keys.ofs-backup ~/.ssh/authorized_keys; fi'
    : 'rm -f ~/.ssh/authorized_keys'
  const out = await run(
    baseSessionId,
    `${cmd}; rm -f ~/.ssh/authorized_keys.ofs-backup ~/.ssh/authorized_keys.ofs-clean; ` +
      `ls -a ~/.ssh 2>/dev/null | grep -v '^\\.\\.\\?$' | tr '\\n' ' '; echo "|preexisted=${authorizedKeysPreexisted}"`
  )
  authorizedKeysTouched = false
  return out.trim()
}

/** 裸 sh exec 通道跑命令（无 PTY，输出干净） */
async function run(sessionId: string, cmd: string, timeoutMs = 30000): Promise<string> {
  const channel = await sshManager.get(sessionId).openMonitorChannel()
  const marker = `__OFS_DONE_${Math.random().toString(36).slice(2)}__`
  let out = ''
  channel.on('data', (c: Buffer) => {
    out += c.toString('utf8')
  })
  channel.write(`${cmd}\necho ${marker}\n`)
  try {
    await waitFor(() => out.includes(marker), timeoutMs, `command: ${cmd}`)
  } finally {
    channel.close()
  }
  return out.slice(0, out.indexOf(marker)).replace(/\r/g, '').trim()
}

function draft(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return {
    name: 'real-advanced',
    groupId: null,
    host: HOST!,
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
    },
    ...overrides
  }
}

/** 自动应答 hostkey 提示（第一组已把指纹存入 known_hosts，这里通常不会再弹） */
function autoTrust(): () => void {
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

beforeAll(async () => {
  if (!enabled) return
  localDir = mkdtempSync(join(tmpdir(), 'ofs-adv-'))
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  patchSettings({
    sftp: {
      downloadDir: localDir,
      maxConcurrentPerSession: 2,
      maxConcurrentGlobal: 4,
      conflictPolicy: 'ask',
      showHiddenFiles: true,
      doubleClickAction: 'download'
    }
  })

  const stop = autoTrust()
  const profile = saveProfile(draft({ name: 'real-advanced-base' }))
  basePasswordProfileId = profile.id
  ;({ sessionId: baseSessionId } = await sshManager.open(profile.id))
  stop()
}, 60000)

afterAll(async () => {
  if (!enabled) return
  // 兜底清理：删掉临时远端文件、恢复 authorized_keys
  try {
    if (baseSessionId && sshManager.tryGet(baseSessionId)) {
      for (const path of remoteCleanup) {
        await run(baseSessionId, `rm -f ${JSON.stringify(path)}`).catch(() => {})
      }
      // 用例内已恢复则无操作；用例中途失败时在这里兜底
      await restoreAuthorizedKeys().catch(() => {})
    }
  } finally {
    transferQueue.cancelAll()
    sshManager.closeAll()
    if (basePasswordProfileId) deleteProfile(basePasswordProfileId)
    console.log('\n===== 进阶验收观测结果 =====')
    for (const [k, v] of Object.entries(observed)) console.log(`${k}: ${v}`)
    console.log('============================\n')
  }
}, 120000)

suite('真实服务器：私钥认证', () => {
  it('临时装公钥 → 私钥+口令登录成功 → 精确移除公钥', async () => {
    const passphrase = 'ofs-acceptance-passphrase'
    const comment = `ofs-acceptance-${Date.now()}`
    // 用系统 ssh-keygen 生成 OpenSSH 新格式加密私钥 —— 这正是用户实际持有的格式。
    // （不要用 Node crypto 的 PKCS#8：ssh2 不支持，见 test/unit/privateKeyFormats.test.ts）
    const keyPath = join(localDir, 'acceptance_ed25519')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', passphrase, '-C', comment, '-f', keyPath], {
      stdio: 'pipe'
    })
    pubKeyLine = (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim()
    expect(pubKeyLine).toContain(comment)

    // 先记录原始状态（决定清理时是删文件还是恢复内容），再备份、追加
    const pre = await run(
      baseSessionId,
      'test -f ~/.ssh/authorized_keys && echo EXISTS || echo ABSENT'
    )
    authorizedKeysPreexisted = pre.includes('EXISTS')
    authorizedKeysTouched = true
    await run(
      baseSessionId,
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
        `if [ -f ~/.ssh/authorized_keys ]; then cp -f ~/.ssh/authorized_keys ~/.ssh/authorized_keys.ofs-backup; fi; ` +
        `printf '%s\\n' ${JSON.stringify(pubKeyLine)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ` +
        `grep -c ${JSON.stringify(comment)} ~/.ssh/authorized_keys`
    )

    // 用私钥+口令连接
    const stop = autoTrust()
    const keyProfile = saveProfile(
      draft({
        name: 'real-advanced-key',
        auth: { method: 'privateKey', privateKeyPath: keyPath, passphrase }
      })
    )
    try {
      const { sessionId } = await sshManager.open(keyProfile.id)
      const whoami = await run(sessionId, 'whoami')
      expect(whoami.trim()).toBe(USER)
      observed.privateKeyAuth = `成功（ssh-keygen 生成的 OpenSSH 格式 ed25519 加密私钥 + 口令，登录为 ${whoami.trim()}）`
      sshManager.close(sessionId)
    } finally {
      stop()
      deleteProfile(keyProfile.id)
    }

    // 口令错误必须报"私钥口令错误"而不是笼统失败
    const stop2 = autoTrust()
    const badProfile = saveProfile(
      draft({
        name: 'real-advanced-key-bad',
        auth: { method: 'privateKey', privateKeyPath: keyPath, passphrase: 'wrong-passphrase' }
      })
    )
    try {
      await expect(sshManager.open(badProfile.id)).rejects.toThrow('私钥口令错误')
      observed.privateKeyBadPassphrase = '报错文案正确（私钥口令错误）'
    } finally {
      stop2()
      deleteProfile(badProfile.id)
    }

    // 不填口令必须提示去填口令，而不是说格式不支持
    const stop3 = autoTrust()
    const noPassProfile = saveProfile(
      draft({
        name: 'real-advanced-key-nopass',
        auth: { method: 'privateKey', privateKeyPath: keyPath }
      })
    )
    try {
      await expect(sshManager.open(noPassProfile.id)).rejects.toThrow(/请在连接配置中填写私钥口令/)
      observed.privateKeyNoPassphrase = '报错文案正确（提示填写口令）'
    } finally {
      stop3()
      deleteProfile(noPassProfile.id)
    }

    // 恢复到测试前的状态：原本不存在就整个删掉，原本存在就从备份恢复
    const after = await restoreAuthorizedKeys()
    observed.authorizedKeysRestored = after
    // 不能残留测试公钥，也不能残留中间文件。
    // 注意：grep -c 无匹配时会「输出 0 且退出码 1」，写成 `grep -c ... || echo 0`
    // 会多打一行 0 把后续解析挤错位 —— 这里用带标记的输出，逐项精确取值。
    const leftover = await run(
      baseSessionId,
      'echo "keys=$(grep -c ofs-acceptance ~/.ssh/authorized_keys 2>/dev/null | head -1)"; ' +
        'echo "temps=$(ls ~/.ssh/authorized_keys.ofs-backup ~/.ssh/authorized_keys.ofs-clean 2>/dev/null | wc -l)"'
    )
    expect(/keys=0?$/m.test(leftover) || /keys=$/m.test(leftover)).toBe(true)
    expect(leftover).toMatch(/temps=\s*0\s*$/m)
  }, 180000)
})

suite('真实服务器：GBK 终端转码', () => {
  it('charset=gbk 时 GBK 字节流被正确解码为中文', async () => {
    const stop = autoTrust()
    const gbkProfile = saveProfile(
      draft({
        name: 'real-advanced-gbk',
        terminal: { charset: 'gbk', termType: 'xterm-256color' }
      })
    )
    try {
      const { sessionId } = await sshManager.open(gbkProfile.id)
      const conn = sshManager.get(sessionId)
      const shell = await conn.openShell(120, 40)
      const termId = shell.termId
      const read = (): string =>
        eventsOf('term:data')
          .filter((e) => e.termId === termId)
          .map((e) => Buffer.from(e.data).toString('utf8'))
          .join('')

      // \xd6\xd0\xce\xc4 = GBK 编码的"中文"；服务器原样吐字节，解码由客户端负责
      shell.write("printf '\\xd6\\xd0\\xce\\xc4\\n'\n")
      await waitFor(() => read().includes('中文'), 20000, 'GBK 解码为中文')
      observed.gbkDecode = '成功（GBK 字节 → 中文）'

      // 上行：客户端把中文编成 GBK 发出，服务器 od 出来应是 d6 d0 ce c4
      shell.write("printf '%s' 中文 | od -An -tx1 | tr -d ' \\n'; echo\n")
      await waitFor(() => /d6d0cec4/.test(read().replace(/\s/g, '')), 20000, 'GBK 编码上行')
      observed.gbkEncode = '成功（中文 → GBK 字节 d6d0cec4）'

      shell.close()
      sshManager.close(sessionId)
    } finally {
      stop()
      deleteProfile(gbkProfile.id)
    }
  }, 120000)
})

suite('真实服务器：非 UTF-8 文件名', () => {
  it('GBK 文件名被标黄禁操作，不影响同目录其他文件', async () => {
    const dir = `/tmp/ofs-badname-${Date.now()}`
    remoteCleanup.push(dir)
    // 用 printf 造一个 GBK 编码的文件名（\xd6\xd0\xce\xc4 = 中文）
    await run(
      baseSessionId,
      `mkdir -p ${dir} && cd ${dir} && printf 'x' > "$(printf '\\xd6\\xd0\\xce\\xc4').txt" && printf 'y' > normal.txt && ls -b`
    )

    const entries = await readdir(baseSessionId, dir)
    observed.badNameEntries = entries.map((e) => `${e.name}${e.badName ? '(标黄)' : ''}`).join(', ')

    const bad = entries.filter((e) => e.badName)
    expect(bad.length).toBeGreaterThan(0)
    // 正常文件不受影响
    const normal = entries.find((e) => e.name === 'normal.txt')
    expect(normal).toBeTruthy()
    expect(normal!.badName).toBeUndefined()

    await run(baseSessionId, `rm -rf ${dir}`)
    remoteCleanup.pop()
  }, 120000)
})

suite('真实服务器：断线自动重连', () => {
  it('连接被强制中断后按退避重连，恢复 ready 并可重开 shell', async () => {
    const stop = autoTrust()
    const reconnProfile = saveProfile(
      draft({
        name: 'real-advanced-reconnect',
        options: {
          keepaliveInterval: 5000,
          readyTimeout: 20000,
          legacyAlgorithms: false,
          autoReconnect: true,
          monitorEnabled: false,
          compress: false
        }
      })
    )
    try {
      const { sessionId } = await sshManager.open(reconnProfile.id)
      const conn = sshManager.get(sessionId)
      const shell = await conn.openShell(80, 24)
      const termId = shell.termId
      await waitFor(
        () => eventsOf('term:data').some((e) => e.termId === termId),
        20000,
        'first shell output'
      )

      const statesBefore = eventsOf('session:state').length
      // 直接销毁底层 socket 模拟拔网线。
      // 不要用 pkill 杀服务器端 sshd —— 它会连带杀掉同账号的其他会话（包括本测试的基础会话）。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawClient = (conn as any).client
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sock = rawClient?._sock ?? rawClient?._client?._sock
      sock?.destroy(new Error('simulated network drop'))

      const states = (): SessionState[] =>
        eventsOf('session:state')
          .slice(statesBefore)
          .map((e) => e.state)
      await waitFor(() => states().includes('reconnecting'), 30000, 'reconnecting state')
      observed.reconnectStates = states().join(' → ')

      // 旧 shell 应标记为 reconnected（renderer 据此重开而不是显示已断开）
      const exit = eventsOf('term:exit').find((e) => e.termId === termId)
      expect(exit?.reason).toBe('reconnected')

      await waitFor(() => states().includes('ready'), 60000, 'recovered to ready')
      const again = await conn.openShell(80, 24)
      expect(again.termId).not.toBe(termId)
      observed.reconnectResult = `恢复成功（状态链：${states().join(' → ')}）`
      again.close()
      sshManager.close(sessionId)
    } finally {
      stop()
      deleteProfile(reconnProfile.id)
    }
  }, 180000)
})

suite('真实服务器：大文件传输', () => {
  it(`${BIG_FILE_MB}MB 上传+下载：字节一致、速率可观测`, async () => {
    const remotePath = `/tmp/ofs-big-${Date.now()}.bin`
    remoteCleanup.push(remotePath)
    const localSrc = join(localDir, 'big-src.bin')
    const localBack = join(localDir, 'big-back.bin')

    // 用可校验的伪随机内容（避免全零被稀疏文件/压缩优化掉）
    const chunk = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) % 256
    const handle = await fs.open(localSrc, 'w')
    try {
      for (let i = 0; i < BIG_FILE_MB; i++) await handle.write(chunk)
    } finally {
      await handle.close()
    }
    const srcStat = await fs.stat(localSrc)

    const upStart = Date.now()
    const [upId] = transferQueue.enqueue([
      { sessionId: baseSessionId, kind: 'upload', localPath: localSrc, remotePath }
    ])
    await waitFor(
      () => ['done', 'error'].includes(transferQueue.list().find((t) => t.id === upId)?.state ?? ''),
      600000,
      'big upload'
    )
    const up = transferQueue.list().find((t) => t.id === upId)!
    expect(up.error ?? '').toBe('')
    expect(up.state).toBe('done')
    const upSec = (Date.now() - upStart) / 1000
    observed.uploadSpeed = `${(BIG_FILE_MB / upSec).toFixed(1)} MB/s（${BIG_FILE_MB}MB / ${upSec.toFixed(1)}s）`

    // 远端大小核对
    const remoteSize = Number((await run(baseSessionId, `stat -c %s ${remotePath}`)).trim())
    expect(remoteSize).toBe(srcStat.size)

    const downStart = Date.now()
    const [downId] = transferQueue.enqueue([
      { sessionId: baseSessionId, kind: 'download', localPath: localBack, remotePath }
    ])
    await waitFor(
      () => ['done', 'error'].includes(transferQueue.list().find((t) => t.id === downId)?.state ?? ''),
      600000,
      'big download'
    )
    expect(transferQueue.list().find((t) => t.id === downId)!.state).toBe('done')
    const downSec = (Date.now() - downStart) / 1000
    observed.downloadSpeed = `${(BIG_FILE_MB / downSec).toFixed(1)} MB/s（${BIG_FILE_MB}MB / ${downSec.toFixed(1)}s）`

    // 内容一致性：分块比对，避免一次读进内存
    const backStat = await fs.stat(localBack)
    expect(backStat.size).toBe(srcStat.size)
    const srcFh = await fs.open(localSrc, 'r')
    const backFh = await fs.open(localBack, 'r')
    try {
      const a = Buffer.alloc(1024 * 1024)
      const b = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < BIG_FILE_MB; i++) {
        await srcFh.read(a, 0, a.length, i * a.length)
        await backFh.read(b, 0, b.length, i * b.length)
        if (!a.equals(b)) throw new Error(`第 ${i} MB 内容不一致`)
      }
    } finally {
      await srcFh.close()
      await backFh.close()
    }
    observed.bigFileIntegrity = '往返字节完全一致'

    await remove(baseSessionId, remotePath, false)
    remoteCleanup.pop()
    // 只检查本任务自己的中间文件，不因 /tmp 里别的残留而失败
    const tmp = await readdir(baseSessionId, '/tmp')
    const ownPart = `${remotePath}.ofspart`
    expect(tmp.some((e) => e.path === ownPart)).toBe(false)
    expect(tmp.some((e) => e.path === remotePath)).toBe(false)
  }, 900000)
})
