/**
 * 真实服务器验收：编辑远端文件 / 快速删除 / 打包下载（默认跳过）。
 *
 * 这三样在 fixture 上**都无法被验证**：
 *  - fixture 的 ssh2 server 端不通告任何 SFTP 扩展，所以 posix-rename 那条主路径没被走过；
 *  - fixture 的 exec 只是面镜子，没有真 shell、没有真文件系统，`rm -rf` 与 `tar` 的语义无从验；
 *  - 权限、umask、软链、`df`/`du`/`tar --version` 的真实输出，一个都没有。
 *
 * 凭据只从环境变量读，不写进代码库：
 *   $env:OFS_TEST_HOST='1.2.3.4'; $env:OFS_TEST_PORT='22'
 *   $env:OFS_TEST_USER='root';    $env:OFS_TEST_PASSWORD='...'
 *   npx vitest run test/integration/realServerBatch3.test.ts
 *
 * **零痕迹纪律**：所有远端改动都在一个 mktemp 出来的目录里，afterAll 无条件删掉；
 * 不碰 authorized_keys、不改任何服务器配置。会在 /tmp 下留下打包用的临时文件吗？
 * 不会 —— 那正是本套要断言的事情之一。
 */
import { existsSync, mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ProfileDraft, TransferTask } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { patchSettings } from '../../src/main/services/settings'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { execOnce } from '../../src/main/ssh/ExecRunner'
import { shQuote } from '../../src/main/ssh/shellQuote'
import { createRemoteEditManager } from '../../src/main/sftp/RemoteEditManager'
import { fastDelete, fastDeletePreview } from '../../src/main/sftp/fastDelete'
import { buildProbeScript, parseRemoteProbe } from '../../src/main/sftp/packTransfer'
import { transferQueue } from '../../src/main/sftp/TransferQueue'
import { toRemotePath } from '../../src/main/sftp/remotePath'

const HOST = process.env.OFS_TEST_HOST
const PORT = Number(process.env.OFS_TEST_PORT ?? 22)
const USER = process.env.OFS_TEST_USER ?? 'root'
const PASSWORD = process.env.OFS_TEST_PASSWORD

const enabled = Boolean(HOST && PASSWORD)
const suite = enabled ? describe : describe.skip

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
function eventsOf<K extends keyof EventMap>(channel: K): Array<EventMap[K]> {
  return events.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
}
async function waitFor(pred: () => boolean, ms = 60_000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

let sessionId = ''
let profileId = ''
/** 远端沙盒（mktemp 出来的），所有改动都在它里面 */
let sandbox = ''
let localDir = ''
/** 观测到的服务器信息，跑完汇总打印 —— 这套测试一半的价值在这些数上 */
const observed: Record<string, string> = {}

function draft(): ProfileDraft {
  return {
    name: 'ofs-batch3-acceptance',
    groupId: null,
    host: HOST as string,
    port: PORT,
    username: USER,
    auth: { method: 'password', password: PASSWORD as string },
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
}

/** 在远端跑一段脚本，拿 stdout；非 0 直接抛（测试里的辅助函数，失败要吵） */
async function sh(script: string): Promise<string> {
  const r = await execOnce(sshManager.get(sessionId), script, { timeoutMs: 120_000 })
  if (r.code !== 0) {
    throw new Error(`远端脚本失败（code=${r.code}）：${r.stderr.slice(0, 500)}\n--- 脚本 ---\n${script}`)
  }
  return r.stdout
}

beforeAll(async () => {
  if (!enabled) return
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

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

  localDir = mkdtempSync(join(tmpdir(), 'ofs-b3-'))
  patchSettings({ sftp: { ...DEFAULT_SETTINGS.sftp, downloadDir: localDir } })

  sandbox = (await sh(`d=$(mktemp -d /tmp/ofs-acc.XXXXXXXX) && printf '%s\\n' "$d"`)).trim()
  observed['sandbox'] = sandbox
}, 120_000)

afterAll(async () => {
  if (!enabled) return
  // 零痕迹：无条件删沙盒（用 SFTP 之外的路，免得依赖被测代码）
  if (sandbox && sandbox.startsWith('/tmp/ofs-acc.')) {
    await execOnce(sshManager.get(sessionId), `rm -rf -- '${sandbox}'`, { timeoutMs: 60_000 }).catch(
      () => {}
    )
  }
  transferQueue.cancelAll()
  sshManager.closeAll()
  if (profileId) deleteProfile(profileId)
  if (localDir) await fs.rm(localDir, { recursive: true, force: true }).catch(() => {})
  if (Object.keys(observed).length > 0) {
    console.log('\n=== 真机观测 ===')
    for (const [k, v] of Object.entries(observed)) console.log(`  ${k}: ${v}`)
  }
}, 120_000)

// ---------------------------------------------------------------------------
// 环境画像：先把这台机器长什么样打出来
// ---------------------------------------------------------------------------

suite('环境画像', () => {
  it('探测脚本在真实服务器上的输出能被 parseRemoteProbe 解开', async () => {
    await sh(`mkdir -p '${sandbox}/probe' && for i in $(seq 1 20); do echo x > '${sandbox}/probe/f'$i; done`)
    const out = await sh(buildProbeScript(toRemotePath(`${sandbox}/probe`)))
    const probe = parseRemoteProbe(out)
    observed['tar'] = probe.tarFlavor
    observed['mktemp'] = String(probe.hasMktemp)
    observed['TMPDIR'] = probe.tmpDir
    observed['probe.entryCount'] = String(probe.entryCount)
    observed['probe.sizeKb'] = String(probe.sizeKb)
    observed['freeTmpKb'] = String(probe.freeTmpKb)
    observed['freeSrcKb'] = String(probe.freeSrcKb)

    expect(probe.tarFlavor).not.toBe('unknown')
    expect(probe.hasMktemp).toBe(true)
    expect(probe.tmpDir.startsWith('/')).toBe(true)
    expect(probe.entryCount).toBeGreaterThanOrEqual(21)
    expect(probe.sizeKb).toBeGreaterThan(0)
    expect(probe.freeTmpKb).not.toBeNull()
    expect(probe.freeSrcKb).not.toBeNull()
  })

  it('posix-rename 到底有没有被通告（编辑功能的主路径）', async () => {
    const sftp = await sshManager.get(sessionId).browseSftpSession()
    let advertised = true
    try {
      // ssh2 对未通告的扩展是**同步 throw**，所以这是零开销的能力探测。
      // 回调里的 err 不看：源文件本来就不存在，服务器必然报错 ——
      // 我们要区分的是"抛出来（没通告）"和"进了回调（通告了）"
      await new Promise<void>((resolve) => {
        sftp.ext_openssh_rename(`${sandbox}/nope-a`, `${sandbox}/nope-b`, () => resolve())
      })
    } catch {
      advertised = false
    }
    observed['posix-rename'] = advertised ? '通告了' : '未通告（编辑会走降级路径）'
    // 不断言真假 —— 两条路都要能用；这里只是把事实记下来
    expect(typeof advertised).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// 快速删除
// ---------------------------------------------------------------------------

suite('快速删除', () => {
  const marker = '/tmp/ofs-pwned-marker'

  it('抗注入：敌意文件名一个都没被执行，同级哨兵没被碰', async () => {
    const tree = `${sandbox}/fd/tree`
    /*
     * 敌意命名。名字本身用 shQuote 包出去 —— 顺手也是对它的一次真机自检：
     * 要是它转义错了，这一步"造树"就先失败，而不是等到删的时候才出问题。
     * （反斜杠开头的那两个是命令替换与反引号，它们必须**只是文件名**。）
     */
    const hostile = ["it's", '$(touch ' + marker + ')', '`touch ' + marker + '2`', '-rf', 'a b', '*']
    await sh(
      [
        `mkdir -p ${shQuote(tree)}`,
        `printf keep > ${shQuote(`${sandbox}/fd/sentinel.txt`)}`,
        ...hostile.map((n) => `mkdir -p ${shQuote(`${tree}/${n}`)}`),
        `printf x > ${shQuote(`${tree}/it's/f.txt`)}`,
        `rm -f ${shQuote(marker)} ${shQuote(`${marker}2`)}`
      ].join('\n')
    )
    // 造出来的名字必须一个不少（证明造树这一步本身没被 shell 吃掉）
    const made = (await sh(`ls -1 ${shQuote(tree)} | wc -l`)).trim()
    expect(Number(made)).toBe(hostile.length)
    // 事先确认注入标记不存在
    expect((await sh(`[ -e ${marker} ] && echo yes || echo no`)).trim()).toBe('no')

    const result = await fastDelete(sessionId, [tree])
    observed['fastDelete.exitCode'] = String(result.exitCode)
    expect(result.exitCode).toBe(0)
    expect(result.leftover).toEqual([])

    expect((await sh(`[ -e '${tree}' ] && echo yes || echo no`)).trim()).toBe('no')
    expect((await sh(`cat '${sandbox}/fd/sentinel.txt'`)).trim()).toBe('keep')
    // 命令替换与反引号都只是文件名的一部分，绝不能真的执行
    expect((await sh(`[ -e ${marker} ] && echo yes || echo no`)).trim()).toBe('no')
    expect((await sh(`[ -e ${marker}2 ] && echo yes || echo no`)).trim()).toBe('no')
  })

  it('含换行的文件名：守卫拦在门外（我们按行解析删除结果）', async () => {
    await expect(fastDelete(sessionId, [`${sandbox}/a\nb`])).rejects.toThrow(/换行/)
  })

  it('守卫在 main 侧真的生效：删 /etc 被拒，且 /etc 仍然存在', async () => {
    await expect(fastDelete(sessionId, ['/etc'])).rejects.toThrow(/层级过浅/)
    await expect(fastDelete(sessionId, ['/'])).rejects.toThrow(/层级过浅/)
    // preview 那条也要拒（它是弹框之前那道）
    expect(() => fastDeletePreview(['/etc'])).toThrow(/层级过浅/)
    expect((await sh(`[ -d /etc ] && echo yes || echo no`)).trim()).toBe('yes')
    expect((await sh(`ls /etc/hostname >/dev/null 2>&1 && echo yes || echo no`)).trim()).toBe('yes')
  })

  it('删不掉时残留探测报得出来（拿一个不可写的父目录当靶子）', async () => {
    // root 无视权限位，所以用 chattr +i（不可变）造"删不掉"；不支持就跳过这条
    const target = `${sandbox}/fd/immutable/child`
    const supported = (
      await sh(
        [
          `mkdir -p '${target}'`,
          `printf x > '${target}/f.txt'`,
          `chattr +i '${target}/f.txt' 2>/dev/null && echo yes || echo no`
        ].join('\n')
      )
    ).trim()
    observed['chattr'] = supported === 'yes' ? '可用' : '不可用（跳过残留探测断言）'
    if (supported !== 'yes') return

    const result = await fastDelete(sessionId, [`${sandbox}/fd/immutable`])
    expect(result.exitCode).not.toBe(0)
    expect(result.leftover).toEqual([`${sandbox}/fd/immutable`])
    expect(result.stderr).not.toBe('')
    // 收尾：解开不可变位，让 afterAll 的 rm -rf 能清干净
    await sh(`chattr -i '${target}/f.txt'`)
  })
})

// ---------------------------------------------------------------------------
// 打包下载
// ---------------------------------------------------------------------------

/** 等某条任务进终态 */
async function waitTask(taskId: string, label: string): Promise<TransferTask> {
  await waitFor(
    () => {
      const t = transferQueue.list().find((x) => x.id === taskId)
      return Boolean(t && ['done', 'error', 'canceled'].includes(t.state))
    },
    180_000,
    label
  )
  return transferQueue.list().find((x) => x.id === taskId) as TransferTask
}

/** 递归比对本地目录与远端目录的内容（用远端 find + md5sum 生成清单） */
async function remoteManifest(dir: string): Promise<string[]> {
  const out = await sh(
    `cd '${dir}' && find . -type f | sort | while IFS= read -r f; do printf '%s %s\\n' "$(md5sum "$f" | cut -d' ' -f1)" "$f"; done`
  )
  // 两侧都按整行排序：远端是 find|sort（按路径），本地是按 "哈希 路径" 排，
  // 不统一的话同一棵树会给出两个不同顺序的清单，比对必然假红
  return out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .sort()
}

async function localManifest(dir: string): Promise<string[]> {
  const { createHash } = await import('node:crypto')
  const out: string[] = []
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(join(dir, rel), { withFileTypes: true })
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) await walk(childRel)
      else if (e.isFile()) {
        const buf = await fs.readFile(join(dir, childRel))
        out.push(`${createHash('md5').update(buf).digest('hex')} ./${childRel}`)
      }
    }
  }
  await walk('')
  return out.sort()
}

suite('打包下载', () => {
  it('敌意树往返：逐字节相等、远端临时包已清、树外哨兵未动', async () => {
    const name = 'packed-tree'
    const tree = `${sandbox}/pack/${name}`
    await sh(
      [
        `mkdir -p '${tree}/deep/deeper/deepest'`,
        `printf sentinel > '${sandbox}/pack/outside.txt'`,
        // 大量小文件（逼过 PACK_MIN_FILES）+ 中文 + emoji + 0 字节 + 空格 + 单引号 + 前导横线
        `for i in $(seq 1 40); do printf 'body-%s' $i > '${tree}/f'$i'.txt'; done`,
        `printf 中文内容 > '${tree}/中文 名.txt'`,
        `printf emoji > '${tree}/日志-🔥.log'`,
        `: > '${tree}/empty'`,
        `printf q > "${tree}/it's.txt"`,
        `printf d > '${tree}/-rf'`,
        `printf deep > '${tree}/deep/deeper/deepest/x.bin'`,
        `ln -s 'f1.txt' '${tree}/link-to-f1'`,
        `mkdir -p '${tree}/-rf-dir'`
      ].join('\n')
    )
    const before = await remoteManifest(tree)
    observed['pack.remoteFiles'] = String(before.length)

    // /tmp 下事先有多少个 ofs-pack.*（跑完必须一个不多）
    const tmpBefore = (await sh(`ls -1 /tmp/ofs-pack.* 2>/dev/null | wc -l`)).trim()

    patchSettings({
      sftp: { ...DEFAULT_SETTINGS.sftp, downloadDir: localDir, packedTransfer: true }
    })
    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', localPath: join(localDir, name), remotePath: tree }
    ])
    const task = await waitTask(taskId, '打包下载完成')
    observed['pack.packed'] = String(task.packed)
    observed['pack.notice'] = task.notice ?? '(无)'
    if (task.error) observed['pack.error'] = task.error

    expect(task.state).toBe('done')
    expect(task.packed).toBe(true)

    // 逐字节相等（软链在 Windows 上解不出来，所以清单比对排除它）
    const after = await localManifest(join(localDir, name))
    const expected = before.filter((l) => !l.endsWith('./link-to-f1'))
    expect(after).toEqual(expected)

    // 远端临时包清掉了，且 /tmp 里没多出孤儿
    const tmpAfter = (await sh(`ls -1 /tmp/ofs-pack.* 2>/dev/null | wc -l`)).trim()
    expect(tmpAfter).toBe(tmpBefore)
    // 树外哨兵没被碰
    expect((await sh(`cat '${sandbox}/pack/outside.txt'`)).trim()).toBe('sentinel')
  }, 300_000)

  it('文件数不够时静默退回逐文件，并说明原因', async () => {
    const name = 'tiny-tree'
    const tree = `${sandbox}/pack/${name}`
    await sh(`mkdir -p '${tree}' && printf a > '${tree}/a.txt' && printf b > '${tree}/b.txt'`)

    // **本用例自己开开关**：靠上一条用例留下的设置会让它单跑时假红，
    // 而"单跑一条用例"正是排查时最常用的动作
    patchSettings({
      sftp: { ...DEFAULT_SETTINGS.sftp, downloadDir: localDir, packedTransfer: true }
    })
    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', localPath: join(localDir, name), remotePath: tree }
    ])
    const task = await waitTask(taskId, '小目录下载完成')
    observed['tiny.notice'] = task.notice ?? '(无)'

    expect(task.state).toBe('done')
    expect(task.packed).not.toBe(true)
    expect(task.notice ?? '').toMatch(/打包省不出往返|逐文件/)
    /*
     * 逐文件那条路照样把文件下下来了。判据用"这两个文件真的出现了"，
     * 不数全局 done 任务数 —— 队列是模块级单例，前面的用例早把那个数顶上去了，
     * 那种断言在整套跑的时候必然已经成立（也就是空转）。
     */
    await waitFor(
      () =>
        existsSync(join(localDir, name, 'a.txt')) && existsSync(join(localDir, name, 'b.txt')),
      120_000,
      '两个子文件落地'
    )
    expect((await fs.readFile(join(localDir, name, 'a.txt'), 'utf8')).trim()).toBe('a')
  }, 180_000)

  it('打包与逐文件下同一棵树，结果逐字节一致', async () => {
    const tree = `${sandbox}/pack/packed-tree`
    const plain = join(localDir, 'plain-copy')
    await fs.mkdir(plain, { recursive: true })

    patchSettings({
      sftp: { ...DEFAULT_SETTINGS.sftp, downloadDir: localDir, packedTransfer: false }
    })
    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', localPath: join(plain, 'packed-tree'), remotePath: tree }
    ])
    await waitTask(taskId, '逐文件下载展开')
    // 目录任务展开成子任务，等队列彻底空下来
    await waitFor(
      () => transferQueue.list().every((t) => ['done', 'error', 'canceled'].includes(t.state)),
      300_000,
      '逐文件下载完成'
    )
    const errors = transferQueue.list().filter((t) => t.state === 'error')
    observed['plain.errors'] = String(errors.length)
    if (errors.length > 0) observed['plain.firstError'] = errors[0].error ?? ''

    const packed = await localManifest(join(localDir, 'packed-tree'))
    const perFile = await localManifest(join(plain, 'packed-tree'))
    // 逐文件那条路会把软链当普通文件下下来，所以只比两边都有的部分
    const onlyBoth = (list: string[]): string[] =>
      list.filter((l) => !l.endsWith('./link-to-f1')).sort()
    expect(onlyBoth(perFile)).toEqual(onlyBoth(packed))
  }, 600_000)
})

// ---------------------------------------------------------------------------
// 编辑远端文件
// ---------------------------------------------------------------------------

suite('编辑远端文件', () => {
  /** 不启动任何编辑器：openEditor 是 no-op，测试自己扮演编辑器去写那个临时文件 */
  const manager = createRemoteEditManager({ openEditor: async () => {} })

  it('往返：改本地临时文件 → 远端内容变了，权限位保住', async () => {
    const target = `${sandbox}/edit/nginx.conf`
    await sh(
      `mkdir -p '${sandbox}/edit' && printf 'server {\\n  listen 80;\\n}\\n' > '${target}' && chmod 640 '${target}'`
    )
    const modeBefore = (await sh(`stat -c '%a' '${target}'`)).trim()
    observed['edit.modeBefore'] = modeBefore

    const entry = await manager.open(sessionId, target)
    await waitFor(
      () => manager.list().find((e) => e.id === entry.id)?.state === 'editing',
      60_000,
      '编辑就绪'
    )
    // 扮演编辑器：原地覆盖（最常见的存盘方式之一）
    await fs.writeFile(entry.localPath, 'server {\n  listen 8080;\n}\n', 'utf8')
    await waitFor(
      () => (manager.list().find((e) => e.id === entry.id)?.savedAt ?? 0) > 0,
      60_000,
      '写回完成'
    )

    expect((await sh(`cat '${target}'`))).toContain('listen 8080')
    const modeAfter = (await sh(`stat -c '%a' '${target}'`)).trim()
    observed['edit.modeAfter'] = modeAfter
    expect(modeAfter).toBe(modeBefore)
    const ownerAfter = (await sh(`stat -c '%U' '${target}'`)).trim()
    observed['edit.ownerAfter'] = ownerAfter
    await manager.stop(entry.id)
  }, 180_000)

  it('软链：编辑完仍然是软链，指向的真身内容变了', async () => {
    const real = `${sandbox}/edit/sites-available/site.conf`
    const link = `${sandbox}/edit/sites-enabled/site.conf`
    await sh(
      [
        `mkdir -p '${sandbox}/edit/sites-available' '${sandbox}/edit/sites-enabled'`,
        `printf 'listen 80;\\n' > '${real}'`,
        `ln -sf '${real}' '${link}'`
      ].join('\n')
    )

    const entry = await manager.open(sessionId, link)
    await waitFor(
      () => manager.list().find((e) => e.id === entry.id)?.state === 'editing',
      60_000,
      '软链编辑就绪'
    )
    await fs.writeFile(entry.localPath, 'listen 9090;\n', 'utf8')
    await waitFor(
      () => (manager.list().find((e) => e.id === entry.id)?.savedAt ?? 0) > 0,
      60_000,
      '软链写回完成'
    )

    const kind = (await sh(`[ -L '${link}' ] && echo symlink || echo regular`)).trim()
    observed['edit.symlinkStaysSymlink'] = kind
    expect(kind).toBe('symlink')
    expect(await sh(`cat '${real}'`)).toContain('listen 9090')
    await manager.stop(entry.id)
  }, 180_000)

  it('远端被别人改过：拦下来等裁决，一个字节都不写', async () => {
    const target = `${sandbox}/edit/conflict.txt`
    await sh(`printf 'original\\n' > '${target}'`)

    const entry = await manager.open(sessionId, target)
    await waitFor(
      () => manager.list().find((e) => e.id === entry.id)?.state === 'editing',
      60_000,
      '冲突用例就绪'
    )
    // 模拟"别人改了远端"
    await sh(`printf 'changed-by-someone-else\\n' > '${target}'`)
    await fs.writeFile(entry.localPath, 'my-local-change\n', 'utf8')

    await waitFor(
      () => manager.list().find((e) => e.id === entry.id)?.state === 'conflict',
      60_000,
      '进入 conflict'
    )
    // 远端内容必须还是别人那一版
    expect(await sh(`cat '${target}'`)).toContain('changed-by-someone-else')

    // 用户点"仍然覆盖"
    await manager.forceSave(entry.id)
    expect(await sh(`cat '${target}'`)).toContain('my-local-change')
    await manager.stop(entry.id)
  }, 180_000)
})
