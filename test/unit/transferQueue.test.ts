import { mkdtempSync, promises as fs, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { EventMap } from '@shared/ipc'
import type { TransferTask } from '@shared/types'

/**
 * 传输队列的调度与分组。**这一片此前零覆盖** —— 28 个单测里没有一个碰
 * TransferQueue / TransferWorker，而这次改动最大的一块正是它。
 *
 * 这里用假连接（只提供一个记账用的 acquireTransferSftp 与一个够用的假 SFTP），
 * 目的是验**调度**：谁能开跑、开跑要不要名额、分组什么时候收尾。真实字节搬运
 * 由 test/integration/sftp.test.ts 打在真 SFTP 服务器上。
 */

const stub = vi.hoisted(() => ({
  /** acquireTransferSftp 被调了几次 —— "展开不占传输额度"那条断言的全部依据 */
  acquireCount: 0,
  releaseCount: 0,
  browseCount: 0,
  /** 假远端：只记录建过哪些目录 */
  dirs: new Set<string>(),
  // vi.hoisted 在 import 之前跑，这里拿不到 DEFAULT_SETTINGS —— beforeEach 里填
  settings: null as unknown as typeof DEFAULT_SETTINGS
}))

const fakeSftp = {
  mkdir: (path: string, cb: (err?: Error) => void) => {
    stub.dirs.add(path)
    cb()
  },
  stat: (_p: string, cb: (err: Error | null) => void) => cb(new Error('no such file')),
  lstat: (_p: string, cb: (err: Error | null) => void) => cb(new Error('no such file'))
}

vi.mock('../../src/main/ssh/SshConnectionManager', () => ({
  sshManager: {
    get: () => ({
      acquireTransferSftp: () => {
        stub.acquireCount += 1
        return Promise.resolve(fakeSftp)
      },
      releaseTransferSftp: () => {
        stub.releaseCount += 1
      },
      browseSftpSession: () => {
        stub.browseCount += 1
        return Promise.resolve(fakeSftp)
      },
      transferExecTarget: () => ({}),
      state: 'ready'
    })
  }
}))
vi.mock('../../src/main/services/settings', () => ({ getSettings: () => stub.settings }))

const { transferQueue } = await import('../../src/main/sftp/TransferQueue')
const { bindMainWindow } = await import('../../src/main/ipc/registry')

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
bindMainWindow({
  isDestroyed: () => false,
  webContents: {
    send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any)

const SID = 'sess-1' as never
let root = ''

function taskOf(id: string): TransferTask | undefined {
  return transferQueue.list().find((t) => t.id === id)
}
async function waitFor(pred: () => boolean, label: string, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
const settled = (id: string): boolean => {
  const t = taskOf(id)
  return Boolean(t && ['done', 'error', 'canceled', 'skipped'].includes(t.state))
}

beforeEach(() => {
  stub.acquireCount = 0
  stub.releaseCount = 0
  stub.browseCount = 0
  stub.dirs.clear()
  stub.settings = structuredClone(DEFAULT_SETTINGS)
  events.length = 0
  root = mkdtempSync(join(tmpdir(), 'ofs-tq-'))
  transferQueue.cancelAll()
  transferQueue.clearFinished()
})

afterEach(async () => {
  transferQueue.cancelAll()
  transferQueue.clearFinished()
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
})

describe('上传目录展开', () => {
  /**
   * 这一条是把上传展开从 start() 里搬出来的**全部依据**，也是整个文件里最重要的断言。
   *
   * 以前展开走 start() 全流程、要 acquireTransferSftp，于是它与真实传输抢同一份
   * maxConcurrentPerSession（默认 2）—— 深目录树上"发现新文件"会被"正在传的文件"饿住。
   */
  it('只有目录时一个传输名额都不占（acquireTransferSftp 从没被调）', async () => {
    await fs.mkdir(join(root, 'a', 'b', 'c'), { recursive: true })
    await fs.mkdir(join(root, 'x'), { recursive: true })

    const [id] = transferQueue.enqueue([
      { sessionId: SID, kind: 'upload', localPath: root, remotePath: '/t' }
    ])
    await waitFor(() => settled(id), 'group settled')

    expect(taskOf(id)!.state).toBe('done')
    expect(stub.acquireCount).toBe(0)
    // 空目录靠浏览句柄 mkdirp 建出来
    expect(stub.browseCount).toBeGreaterThan(0)
  })

  it('空目录在远端如实建出来（含深层）', async () => {
    await fs.mkdir(join(root, 'deep', 'empty'), { recursive: true })

    const [id] = transferQueue.enqueue([
      { sessionId: SID, kind: 'upload', localPath: root, remotePath: '/t' }
    ])
    await waitFor(() => settled(id), 'group settled')

    expect([...stub.dirs]).toContain('/t/deep/empty')
  })

  it('分组任务带 isGroup，且 childTotal 等于真实子项数', async () => {
    await fs.mkdir(join(root, 'd1'), { recursive: true })
    await fs.mkdir(join(root, 'd2'), { recursive: true })
    await fs.mkdir(join(root, 'd3'), { recursive: true })

    const [id] = transferQueue.enqueue([
      { sessionId: SID, kind: 'upload', localPath: root, remotePath: '/t' }
    ])
    await waitFor(() => settled(id), 'group settled')

    const group = taskOf(id)!
    expect(group.isGroup).toBe(true)
    expect(group.childTotal).toBe(3)
    expect(group.childDone).toBe(3)
  })

  /** stat 会跟随软链接：一条指向祖先的链接就是无限展开 */
  it('软链接被跳过并计数', async () => {
    await fs.mkdir(join(root, 'real'), { recursive: true })
    let canLink = true
    try {
      symlinkSync(join(root, 'real'), join(root, 'loop'), 'dir')
    } catch {
      canLink = false
    }
    if (!canLink) {
      console.log('SKIP 软链接用例（本机建不出符号链接）')
      return
    }

    const [id] = transferQueue.enqueue([
      { sessionId: SID, kind: 'upload', localPath: root, remotePath: '/t' }
    ])
    await waitFor(() => settled(id), 'group settled')

    expect(taskOf(id)!.skippedLinks).toBe(1)
    // 链接自己没有变成一条子任务
    expect(transferQueue.list().some((t) => t.remotePath === '/t/loop')).toBe(false)
  })

  it('本地路径不存在 → 任务 error，不是静默 done', async () => {
    const [id] = transferQueue.enqueue([
      { sessionId: SID, kind: 'upload', localPath: join(root, 'nope'), remotePath: '/t/nope' }
    ])
    await waitFor(() => settled(id), 'settled')
    const task = taskOf(id)!
    expect(task.state).toBe('error')
    expect(task.error).toContain('本地文件不存在')
    expect(stub.acquireCount).toBe(0)
  })
})

describe('分组收尾与级联', () => {
  /** 父任务以前一入队完子任务就 done，于是界面上永远显示不出"这个目录 3/800" */
  it('分组在子任务全部终态之后才进终态', async () => {
    await fs.mkdir(join(root, 'sub'), { recursive: true })
    await fs.mkdir(join(root, 'sub', 'inner'), { recursive: true })

    const [id] = transferQueue.enqueue([
      { sessionId: SID, kind: 'upload', localPath: root, remotePath: '/t' }
    ])
    await waitFor(() => settled(id), 'group settled')

    // 分组终态时，所有后代都已终态
    const descendants = transferQueue.list().filter((t) => t.remotePath.startsWith('/t/'))
    expect(descendants.length).toBeGreaterThan(0)
    for (const d of descendants) expect(['done', 'error', 'canceled', 'skipped']).toContain(d.state)
  })

  it('对分组取消会级联到所有子孙', async () => {
    await fs.mkdir(join(root, 'a'), { recursive: true })
    await fs.mkdir(join(root, 'b'), { recursive: true })

    const [id] = transferQueue.enqueue([
      { sessionId: SID, kind: 'upload', localPath: root, remotePath: '/t' }
    ])
    await waitFor(() => (taskOf(id)?.childTotal ?? 0) >= 2, 'children enqueued')
    transferQueue.control(id, 'cancel')

    const all = transferQueue.list().filter((t) => t.remotePath.startsWith('/t'))
    for (const t of all) {
      expect(['canceled', 'done', 'error', 'skipped'], t.remotePath).toContain(t.state)
    }
  })

  /** 让分组重新走一遍展开就是整棵树翻倍 */
  it('分组 retry 不会把子任务翻倍', async () => {
    await fs.mkdir(join(root, 'a'), { recursive: true })
    await fs.mkdir(join(root, 'b'), { recursive: true })

    const [id] = transferQueue.enqueue([
      { sessionId: SID, kind: 'upload', localPath: root, remotePath: '/t' }
    ])
    await waitFor(() => settled(id), 'group settled')
    const before = transferQueue.list().length

    transferQueue.control(id, 'retry')
    await waitFor(() => settled(id), 'group settled again')
    expect(transferQueue.list().length).toBe(before)
  })
})

describe('入队与终态', () => {
  /** 不入队会让用户以为文件被吞了；落 done 会让"800/800 完成"撒谎 */
  it('skipExisting 的项落 skipped 终态，且不开任何连接', async () => {
    await fs.writeFile(join(root, 'f.txt'), 'x')
    const [id] = transferQueue.enqueue([
      {
        sessionId: SID,
        kind: 'upload',
        localPath: join(root, 'f.txt'),
        remotePath: '/t/f.txt',
        skipExisting: true
      }
    ])
    expect(taskOf(id)!.state).toBe('skipped')
    expect(stub.acquireCount).toBe(0)
    expect(taskOf(id)!.transferred).toBe(0)
  })

  it('clearFinished 把 skipped 也清掉（漏了它"清除已完成"就清不干净）', async () => {
    await fs.writeFile(join(root, 'f.txt'), 'x')
    transferQueue.enqueue([
      {
        sessionId: SID,
        kind: 'upload',
        localPath: join(root, 'f.txt'),
        remotePath: '/t/f.txt',
        skipExisting: true
      }
    ])
    expect(transferQueue.list().some((t) => t.state === 'skipped')).toBe(true)
    transferQueue.clearFinished()
    expect(transferQueue.list().some((t) => t.state === 'skipped')).toBe(false)
  })

  /** 两个调用点（退出前、装更新前）都表示"这就下去了"，留几万条 queued 是错账 */
  it('cancelAll 连 queued 一起砍', async () => {
    stub.settings.sftp.maxConcurrentGlobal = 1
    stub.settings.sftp.maxConcurrentPerSession = 1
    for (let i = 0; i < 5; i++) await fs.writeFile(join(root, `f${i}.bin`), 'x'.repeat(64))
    const ids = transferQueue.enqueue(
      Array.from({ length: 5 }, (_, i) => ({
        sessionId: SID,
        kind: 'upload' as const,
        localPath: join(root, `f${i}.bin`),
        remotePath: `/t/f${i}.bin`
      }))
    )
    // 等它们分类完（都是文件，会进 queued）
    await waitFor(() => ids.every((id) => taskOf(id)?.size === 64), 'classified')

    transferQueue.cancelAll()
    for (const id of ids) {
      expect(['canceled', 'done', 'error'], id).toContain(taskOf(id)!.state)
    }
    expect(transferQueue.list().some((t) => t.state === 'queued')).toBe(false)
  })

  it('controlAll 回报真的动到的条数', async () => {
    await fs.writeFile(join(root, 'a.bin'), 'x')
    await fs.writeFile(join(root, 'b.bin'), 'x')
    const ids = transferQueue.enqueue([
      { sessionId: SID, kind: 'upload', localPath: join(root, 'a.bin'), remotePath: '/t/a.bin' },
      { sessionId: SID, kind: 'upload', localPath: join(root, 'b.bin'), remotePath: '/t/b.bin' }
    ])
    await waitFor(() => ids.every((id) => taskOf(id) !== undefined), 'enqueued')
    const affected = transferQueue.controlAll('cancel')
    expect(affected).toBeGreaterThan(0)
    expect(transferQueue.list().every((t) => t.state !== 'queued')).toBe(true)
  })
})

describe('状态事件合批', () => {
  /**
   * 没有合批，一次批量入队就是 N 条同步 IPC 穿过去。这里只入队不传输
   * （假 SFTP 让传输立刻失败），量的是**事件条数**而不是传输结果。
   */
  it('入队 300 条只发出个位数量级的 transfer:states', async () => {
    for (let i = 0; i < 300; i++) await fs.writeFile(join(root, `f${i}.bin`), 'x')
    events.length = 0
    const ids = transferQueue.enqueue(
      Array.from({ length: 300 }, (_, i) => ({
        sessionId: SID,
        kind: 'upload' as const,
        localPath: join(root, `f${i}.bin`),
        remotePath: `/t/f${i}.bin`
      }))
    )
    await waitFor(() => ids.every((id) => settled(id)), 'all settled', 20000)
    // 最后一批状态还在合批窗口里等着（TRANSFER_STATE_FLUSH_MS = 100），等它出来
    await new Promise((r) => setTimeout(r, 250))

    const batches = events.filter((e) => e.channel === 'transfer:states')
    // 300 条任务、每条至少走 queued→running→终态，不合批就是 900+ 条事件
    // 300 条任务各走 queued→running→终态，不合批就是 900 条事件。实测合批后是 1 条；
    // 阈值给 20 是留时序余量，不是"大概吧"
    expect(batches.length).toBeLessThan(20)
    // 每个 id 至少在某一批里露过面，且最后一次是终态
    const lastState = new Map<string, string>()
    for (const b of batches) {
      for (const t of (b.payload as { tasks: TransferTask[] }).tasks) lastState.set(t.id, t.state)
    }
    for (const id of ids) {
      expect(lastState.has(id), id).toBe(true)
      expect(['done', 'error', 'canceled', 'skipped'], id).toContain(lastState.get(id)!)
    }
  })

  it('批里同一个任务只出现一次（缓的是 id，不是每次变更一份快照）', async () => {
    await fs.writeFile(join(root, 'f.bin'), 'x')
    events.length = 0
    const [id] = transferQueue.enqueue([
      { sessionId: SID, kind: 'upload', localPath: join(root, 'f.bin'), remotePath: '/t/f.bin' }
    ])
    await waitFor(() => settled(id), 'settled')
    for (const e of events.filter((x) => x.channel === 'transfer:states')) {
      const tasks = (e.payload as { tasks: TransferTask[] }).tasks
      expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length)
    }
  })
})
