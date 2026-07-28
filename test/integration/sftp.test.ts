import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, promises as fs, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ProfileDraft, TransferTask } from '@shared/types'
import { DEFAULT_SETTINGS, TRANSFER_FINAL_STATES } from '@shared/constants'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { patchSettings } from '../../src/main/services/settings'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { readdir, mkdir, rename, remove, chmod, realpath } from '../../src/main/sftp/SftpManager'
import { transferQueue } from '../../src/main/sftp/TransferQueue'

const PORT = 2240
let sftpRoot = ''
let localDir = ''
let server: ChildProcess
let sessionId = ''
let profileId = ''

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []

/**
 * 事件到达时的**同步**钩子。「传输中途插进去取消/暂停」这类用例只能靠它。
 *
 * 为什么不能轮询 `state === 'running'` 再 control()：本地 fixture 上 8MB 在两次
 * 30ms 轮询之间就传完了，于是那两条用例一直走 `if (task.state === 'canceled')`
 * 的 else 分支 —— 也就是说 .part / .ofspart 的清理**从来没有被真正验证过**
 * （这次给上传补对称清理时才发现，一探就是 'done'）。
 *
 * 换成钩子之后是确定的：runWindow 在发出任何请求**之前**先 onProgress(0)，
 * 那一下是同步 emit，我们在它里面把 canceled 翻起来，外层循环第一次
 * abortIfRequested() 就抛 —— 此时 .part/.ofspart 已由 open 建出来了，正是要验的状态。
 */
let onEvent: ((channel: keyof EventMap, payload: unknown) => void) | null = null

/** 首个 transfer:progress 一到就对该任务下手，返回清理函数 */
function onFirstProgress(taskId: string, act: () => void): () => void {
  let fired = false
  onEvent = (channel, payload) => {
    if (fired || channel !== 'transfer:progress') return
    if ((payload as { taskId: string }).taskId !== taskId) return
    fired = true
    act()
  }
  return () => {
    onEvent = null
  }
}
function eventsOf<K extends keyof EventMap>(channel: K): Array<EventMap[K]> {
  return events.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
}
function taskState(taskId: string): TransferTask | undefined {
  return transferQueue.list().find((t) => t.id === taskId)
}
async function waitFor(pred: () => boolean, ms = 20000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 30))
  }
}
async function waitTask(taskId: string, states: Array<TransferTask['state']>): Promise<TransferTask> {
  await waitFor(
    () => {
      const t = taskState(taskId)
      return Boolean(t && states.includes(t.state))
    },
    30000,
    `task ${taskId} → ${states.join('|')} (now ${taskState(taskId)?.state})`
  )
  return taskState(taskId)!
}

function draft(): ProfileDraft {
  return {
    name: 'sftp-fixture',
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

beforeAll(async () => {
  sftpRoot = mkdtempSync(join(tmpdir(), 'ofs-sftp-srv-'))
  localDir = mkdtempSync(join(tmpdir(), 'ofs-sftp-local-'))
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => {
        events.push({ channel, payload })
        onEvent?.(channel, payload)
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  server = spawn(process.execPath, ['test/fixtures/testSshServer.mjs', String(PORT), sftpRoot], {
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

  // 预置远端内容
  await fs.mkdir(join(sftpRoot, 'sub'), { recursive: true })
  await fs.writeFile(join(sftpRoot, 'hello.txt'), 'hello sftp\n')
  await fs.writeFile(join(sftpRoot, '.hidden'), 'hidden\n')
  await fs.writeFile(join(sftpRoot, 'sub', 'nested.txt'), 'nested\n')

  const trustPrompts = setInterval(() => {
    for (const p of eventsOf('session:prompt')) {
      if (p.kind === 'hostkey-new' || p.kind === 'hostkey-changed') {
        promptBroker.reply({ requestId: p.requestId, ok: true, remember: true })
      }
    }
  }, 20)
  const profile = saveProfile(draft())
  profileId = profile.id
  ;({ sessionId } = await sshManager.open(profile.id))
  clearInterval(trustPrompts)

  // 只覆盖本用例真正在乎的键；其余取默认值，免得每加一个设置就来改这三个测试
  patchSettings({ sftp: { ...DEFAULT_SETTINGS.sftp, downloadDir: localDir } })
})

afterAll(() => {
  transferQueue.cancelAll()
  sshManager.closeAll()
  if (profileId) deleteProfile(profileId)
  server?.kill()
})

describe('SFTP 浏览', () => {
  it('readdir 返回条目、类型、权限串与属主', async () => {
    const entries = await readdir(sessionId, '/')
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(['.hidden', 'hello.txt', 'sub'])

    const file = entries.find((e) => e.name === 'hello.txt')!
    expect(file.type).toBe('file')
    expect(file.size).toBe(11)
    expect(file.modeStr).toMatch(/^-[rwx-]{9}$/)
    expect(file.path).toBe('/hello.txt')

    const dir = entries.find((e) => e.name === 'sub')!
    expect(dir.type).toBe('dir')
    expect(dir.modeStr.startsWith('d')).toBe(true)
  })

  it('realpath / mkdir / rename / chmod / 递归删除', async () => {
    expect(await realpath(sessionId, '.')).toBeTruthy()

    await mkdir(sessionId, '/newdir')
    expect((await readdir(sessionId, '/')).some((e) => e.name === 'newdir')).toBe(true)

    await rename(sessionId, '/newdir', '/renamed')
    const afterRename = await readdir(sessionId, '/')
    expect(afterRename.some((e) => e.name === 'renamed')).toBe(true)
    expect(afterRename.some((e) => e.name === 'newdir')).toBe(false)

    // chmod 请求必须能往返；Windows 的 fs.chmod 只认只读位，
    // 因此只在 POSIX 上断言精确权限位（fixture 平台限制，非客户端问题）
    await chmod(sessionId, '/hello.txt', 0o640)
    const file = (await readdir(sessionId, '/')).find((e) => e.name === 'hello.txt')!
    if (process.platform === 'win32') {
      expect(file.modeStr).toMatch(/^-/)
    } else {
      expect(file.mode & 0o777).toBe(0o640)
    }

    // 递归删除：目录里放个文件再删整棵
    await fs.writeFile(join(sftpRoot, 'renamed', 'inner.txt'), 'x')
    await remove(sessionId, '/renamed', true)
    expect(existsSync(join(sftpRoot, 'renamed'))).toBe(false)
  })

  it('Windows 反斜杠路径被规范化，不会打到错误目录', async () => {
    const entries = await readdir(sessionId, '\\sub')
    expect(entries.map((e) => e.name)).toEqual(['nested.txt'])
  })
})

describe('SFTP 传输', () => {
  it('下载文件：.part 中转后 rename 为最终名，内容一致', async () => {
    const [taskId] = transferQueue.enqueue([
      {
        sessionId,
        kind: 'download',
        remotePath: '/hello.txt',
        localPath: join(localDir, 'hello.txt')
      }
    ])
    const task = await waitTask(taskId, ['done', 'error'])
    expect(task.state).toBe('done')
    expect(await fs.readFile(join(localDir, 'hello.txt'), 'utf8')).toBe('hello sftp\n')
    expect(existsSync(join(localDir, 'hello.txt.part'))).toBe(false)
  })

  it('上传文件：.ofspart 中转后 rename，远端内容一致', async () => {
    const src = join(localDir, 'upload-me.bin')
    const payload = Buffer.alloc(256 * 1024, 7)
    await fs.writeFile(src, payload)

    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'upload', localPath: src, remotePath: '/uploaded.bin' }
    ])
    const task = await waitTask(taskId, ['done', 'error'])
    expect(task.state).toBe('done')
    const remote = await fs.readFile(join(sftpRoot, 'uploaded.bin'))
    expect(remote.length).toBe(payload.length)
    expect(remote.equals(payload)).toBe(true)
    expect(existsSync(join(sftpRoot, 'uploaded.bin.ofspart'))).toBe(false)
  })

  /*
   * 上传目录树。三条断言各对应展开路径上一个此前静默出错的地方：
   * 空目录被丢掉、软链接被跟随、以及分组任务一入队完子任务就 done（于是界面上
   * 永远显示不出"这个目录传到第几个了"）。
   *
   * fixture 的 MKDIR 是**非递归**的，所以"深层空目录也能建出来"这条同时验证了
   * mkdirp 的逐级 ancestor 循环 —— 那正是它存在的理由。
   */
  it('上传目录树：空目录如实建、软链接跳过、分组等子任务全完成才终态', async () => {
    const root = join(localDir, 'tree')
    await fs.mkdir(join(root, 'deep', 'empty'), { recursive: true })
    await fs.mkdir(join(root, 'files'), { recursive: true })
    await fs.writeFile(join(root, 'files', 'a.txt'), 'aaa')
    await fs.writeFile(join(root, 'files', 'b.txt'), 'bbbb')

    // 软链接在 Windows 上要管理员/开发者模式；建不出来就跳过这一半断言
    let linked = false
    try {
      await fs.symlink(join(root, 'files', 'a.txt'), join(root, 'link.txt'))
      linked = true
    } catch {
      linked = false
    }

    const [groupId] = transferQueue.enqueue([
      { sessionId, kind: 'upload', localPath: root, remotePath: '/tree' }
    ])
    const group = await waitTask(groupId, ['done', 'error'])
    expect(group.state).toBe('done')
    expect(group.isGroup).toBe(true)

    // 分组的终态必须落在所有子孙之后
    const descendantsPending = transferQueue
      .list()
      .filter((t) => t.remotePath.startsWith('/tree/'))
      .filter((t) => !TRANSFER_FINAL_STATES.has(t.state))
    expect(descendantsPending).toHaveLength(0)

    expect(await fs.readFile(join(sftpRoot, 'tree', 'files', 'a.txt'), 'utf8')).toBe('aaa')
    expect(await fs.readFile(join(sftpRoot, 'tree', 'files', 'b.txt'), 'utf8')).toBe('bbbb')
    // 空目录：以前这里什么都不会有
    expect(existsSync(join(sftpRoot, 'tree', 'deep', 'empty'))).toBe(true)
    expect(await fs.readdir(join(sftpRoot, 'tree', 'deep', 'empty'))).toEqual([])

    if (linked) {
      expect(existsSync(join(sftpRoot, 'tree', 'link.txt'))).toBe(false)
      const total = transferQueue
        .list()
        .filter((t) => t.remotePath.startsWith('/tree'))
        .reduce((sum, t) => sum + (t.skippedLinks ?? 0), 0)
      expect(total).toBeGreaterThanOrEqual(1)
    } else {
      console.log('SKIP 软链接断言（本机建不出符号链接）')
    }
  })

  /**
   * 一棵只有目录的树：每一层都要在远端出现，且**并发压到 1 也不会卡住**。
   *
   * 注意这条**证明不了**"展开没占传输额度"（旧实现串行地也能跑完，只是慢），
   * 那一条只能用源码护栏精确钉住 —— 见 test/renderer/sftpBatchUploadWiring.test.ts
   * 里那条"expandUpload 块内不许出现 acquireTransferSftp"。这里验的是它真的建对了。
   */
  it('只有目录的深树：每层都在远端建出来（并发压到 1 也不卡）', async () => {
    const prev = DEFAULT_SETTINGS.sftp
    patchSettings({ sftp: { ...prev, maxConcurrentPerSession: 1, maxConcurrentGlobal: 1 } })
    try {
      const root = join(localDir, 'dirs-only')
      await fs.mkdir(join(root, 'a', 'b', 'c'), { recursive: true })
      await fs.mkdir(join(root, 'x', 'y'), { recursive: true })

      const [groupId] = transferQueue.enqueue([
        { sessionId, kind: 'upload', localPath: root, remotePath: '/dirs-only' }
      ])
      const group = await waitTask(groupId, ['done', 'error'])
      expect(group.state).toBe('done')
      expect(existsSync(join(sftpRoot, 'dirs-only', 'a', 'b', 'c'))).toBe(true)
      expect(existsSync(join(sftpRoot, 'dirs-only', 'x', 'y'))).toBe(true)
    } finally {
      patchSettings({ sftp: prev })
    }
  })

  /*
   * ⚠️ 冲突语义的**断言边界**，动这一段前先读这段话。
   *
   * 本地 fixture 的 RENAME 是 `fs.renameSync` —— 它**会覆盖**，而真 SFTP 的 rename
   * 不覆盖；MKDIR 也是非递归的。所以：
   *
   * - `skip` / `overwrite` 的语义在这里**验不了**。写成 `if (state === 'canceled')`
   *   那种带条件的断言会永远绿（覆盖了也不报错，而分支根本没走到）——
   *   那些用例归 test/unit/conflictPlan.test.ts（纯函数）。
   * - 能在这里可靠验的只有 **rename 分支的落地名**：断言两个名字同时存在、内容不同。
   *   它不依赖 rename 的撞名语义，只依赖"文件确实落到了新名字上"。
   */
  it('rename 策略：落到 名字 (2).后缀，原文件一个字节没动', async () => {
    await fs.writeFile(join(sftpRoot, 'dup.txt'), 'original')
    const src = join(localDir, 'dup.txt')
    await fs.writeFile(src, 'incoming')

    const [taskId] = transferQueue.enqueue([
      {
        sessionId,
        kind: 'upload',
        localPath: src,
        remotePath: '/dup.txt',
        onConflict: 'rename'
      }
    ])
    const task = await waitTask(taskId, ['done', 'error'])
    expect(task.state).toBe('done')
    // 原文件未动
    expect(await fs.readFile(join(sftpRoot, 'dup.txt'), 'utf8')).toBe('original')
    // 新内容落在 (2) 上，且任务的 remotePath 已经反映真实落地名
    expect(await fs.readFile(join(sftpRoot, 'dup (2).txt'), 'utf8')).toBe('incoming')
    expect(task.remotePath).toBe('/dup (2).txt')
    expect(existsSync(join(sftpRoot, 'dup.txt.ofspart'))).toBe(false)
  })

  /**
   * skip 的**可验部分**：入队前就探到撞名 → 一个字节都不该发出去。
   * （"目标内容没被改" 这一半在 fixture 上是假绿，见上面那段说明。）
   */
  it('skip 策略：撞名的项直接落 skipped，不开传输', async () => {
    await fs.writeFile(join(sftpRoot, 'exists.txt'), 'keep me')
    const src = join(localDir, 'exists.txt')
    await fs.writeFile(src, 'x'.repeat(4096))

    const [taskId] = transferQueue.enqueue([
      {
        sessionId,
        kind: 'upload',
        localPath: src,
        remotePath: '/exists.txt',
        // 入队前的探测由 applyConflictPlan 做（IPC 层），这里直接给结果
        skipExisting: true,
        onConflict: 'skip'
      }
    ])
    const task = await waitTask(taskId, ['skipped', 'done', 'error'])
    expect(task.state).toBe('skipped')
    expect(task.transferred).toBe(0)
    expect(existsSync(join(sftpRoot, 'exists.txt.ofspart'))).toBe(false)
  })

  it('大文件下载有进度事件且字节数完整', async () => {
    const bigRemote = join(sftpRoot, 'big.bin')
    const size = 3 * 1024 * 1024
    await fs.writeFile(bigRemote, Buffer.alloc(size, 3))
    events.length = 0

    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', remotePath: '/big.bin', localPath: join(localDir, 'big.bin') }
    ])
    const task = await waitTask(taskId, ['done', 'error'])
    expect(task.state).toBe('done')
    expect((await fs.stat(join(localDir, 'big.bin'))).size).toBe(size)

    const progress = eventsOf('transfer:progress').filter((p) => p.taskId === taskId)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)!.total).toBe(size)
  })

  it('目录下载渐进式展开为子任务', async () => {
    const [dirTaskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', remotePath: '/sub', localPath: join(localDir, 'sub') }
    ])
    await waitTask(dirTaskId, ['done', 'error'])

    // 子任务由目录任务入队，等其完成
    await waitFor(
      () => transferQueue.list().some((t) => t.remotePath === '/sub/nested.txt' && t.state === 'done'),
      20000,
      'nested file downloaded'
    )
    expect(await fs.readFile(join(localDir, 'sub', 'nested.txt'), 'utf8')).toBe('nested\n')
  })

  it('取消运行中的任务不留 .part 残留', async () => {
    const size = 8 * 1024 * 1024
    await fs.writeFile(join(sftpRoot, 'cancel-me.bin'), Buffer.alloc(size, 9))
    const target = join(localDir, 'cancel-me.bin')

    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', remotePath: '/cancel-me.bin', localPath: target }
    ])
    const stop = onFirstProgress(taskId, () => transferQueue.control(taskId, 'cancel'))
    try {
      const task = await waitTask(taskId, ['canceled', 'done', 'error'])
      // 无条件断言：钩子让取消一定赶在传输前面（见 onFirstProgress 的说明）
      expect(task.state).toBe('canceled')
      expect(existsSync(`${target}.part`)).toBe(false)
      expect(existsSync(target)).toBe(false)
    } finally {
      stop()
    }
  })

  /*
   * 上传方向的对称用例。以前这条路上取消只有一句裸的 abortIfRequested()，
   * 于是远端留一个 .ofspart —— 本地下载那边一直是删的。
   */
  it('取消运行中的上传不留远端 .ofspart 残留', async () => {
    const src = join(localDir, 'cancel-up.bin')
    await fs.writeFile(src, Buffer.alloc(8 * 1024 * 1024, 11))

    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'upload', localPath: src, remotePath: '/cancel-up.bin' }
    ])
    const stop = onFirstProgress(taskId, () => transferQueue.control(taskId, 'cancel'))
    try {
      const task = await waitTask(taskId, ['canceled', 'done', 'error'])
      expect(task.state).toBe('canceled')
      expect(existsSync(join(sftpRoot, 'cancel-up.bin.ofspart'))).toBe(false)
      expect(existsSync(join(sftpRoot, 'cancel-up.bin'))).toBe(false)
    } finally {
      stop()
    }
  })

  it('暂停后继续可完成传输（offset 续传）', async () => {
    const size = 6 * 1024 * 1024
    await fs.writeFile(join(sftpRoot, 'resume-me.bin'), Buffer.alloc(size, 5))
    const target = join(localDir, 'resume-me.bin')

    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', remotePath: '/resume-me.bin', localPath: target }
    ])
    const stop = onFirstProgress(taskId, () => transferQueue.control(taskId, 'pause'))
    try {
      const paused = await waitTask(taskId, ['paused', 'done'])
      expect(paused.state).toBe('paused')
      // 暂停与取消相反：.part 必须留着，续传才接得上
      expect(existsSync(`${target}.part`)).toBe(true)
    } finally {
      stop()
    }
    transferQueue.control(taskId, 'resume')
    const done = await waitTask(taskId, ['done', 'error'])
    expect(done.state).toBe('done')
    expect((await fs.stat(target)).size).toBe(size)
  })

  it('远端文件不存在时报错，不产生本地文件', async () => {
    const target = join(localDir, 'nope.bin')
    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', remotePath: '/does-not-exist', localPath: target }
    ])
    const task = await waitTask(taskId, ['error', 'done'])
    expect(task.state).toBe('error')
    expect(task.error).toBeTruthy()
    expect(existsSync(target)).toBe(false)
  })

  it('clearFinished 清掉终态任务', async () => {
    expect(transferQueue.list().some((t) => t.state === 'done')).toBe(true)
    transferQueue.clearFinished()
    expect(
      transferQueue.list().filter((t) => TRANSFER_FINAL_STATES.has(t.state))
    ).toHaveLength(0)
  })
})
