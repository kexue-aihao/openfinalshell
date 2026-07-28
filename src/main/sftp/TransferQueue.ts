import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import type { SFTPWrapper } from 'ssh2'
import type {
  SessionId,
  TaskId,
  TransferEnqueueItem,
  TransferPhase,
  TransferTask
} from '@shared/types'
import {
  EXPAND_MAX_DEPTH,
  EXPAND_MAX_TASKS,
  TRANSFER_FINAL_STATES,
  TRANSFER_PROGRESS_INTERVAL_MS,
  TRANSFER_STATE_FLUSH_MAX,
  TRANSFER_STATE_FLUSH_MS
} from '@shared/constants'
import { emit } from '../ipc/registry'
import { getSettings } from '../services/settings'
import type { SshConnection } from '../ssh/SshConnection'
import { sshManager } from '../ssh/SshConnectionManager'
import { planPackedDownload, runPackedDownload, type PackDecision } from './packTransfer'
import { mkdirp, readdirRaw, statSize } from './SftpManager'
import {
  longPath,
  remoteJoin,
  sanitizeLocalName,
  toRemotePath,
  type RemotePath
} from './remotePath'
import { runTransfer, TransferAborted, type WorkerHandle } from './TransferWorker'
import { scopedLogger } from '../utils/logger'

/**
 * 打包用的本地临时目录。放在 app.getPath('temp') 下的固定子目录，
 * 于是启动时可以整目录清扫（见 main/index.ts）—— 没有这条，一次 4GB 打包下载
 * 崩在中途就静默漏 4GB 的 %TEMP%。
 */
export function packTempDir(): string {
  return join(app.getPath('temp'), 'ofs-pack')
}

/**
 * 下载任务的落地名过一遍 sanitizeLocalName。
 *
 * 修的是一个既有 bug：`expandIfDirectory` 展开子项时用了 sanitizeLocalName，
 * 但**顶层那一项的名字从来没过** —— 于是今天下载一个叫 `a:b` 或 `con` 的顶层文件
 * 就已经失败（Windows 上建不出那个名字），而错误信息是一句莫名的 ENOENT/EINVAL。
 *
 * 放在这里而不是渲染进程：sanitizeLocalName 是 main 侧的模块，而这条 channel
 * （transfer:enqueue）是所有下载的唯一入口，改一处就都覆盖到了。
 */
function sanitizeDownloadPath(p: string): string {
  const base = basename(p)
  const safe = sanitizeLocalName(base)
  return safe === base ? p : join(dirname(p), safe)
}

const log = scopedLogger('queue')

/** 终态集合来自 @shared/constants —— 全项目只有那一份，见它的注释 */
const FINAL_STATES = TRANSFER_FINAL_STATES

interface Entry {
  task: TransferTask
  handle: WorkerHandle | null
  /** 该任务已跑过一次（暂停后继续 → 走续传） */
  attempted: boolean
  /**
   * 已经分过类（本地 lstat 跑过了，知道它是文件还是目录）。
   *
   * 上传任务入队时是 false —— `pump()` 不许 start 它，它得先过展开队列。
   * 下载任务恒为 true（远端的分类只能在 start 里做，那需要 SFTP）。
   */
  classified: boolean
  parent: Entry | null
  children: Entry[]
  /** 展开深度，用来兜住环 */
  depth: number
  /** 已经累加给祖先的字节数（与 lastBytes 不同：那个是算速度用的、跟着节流走） */
  rolledBytes: number
  lastReport: number
  lastBytes: number
  lastBytesAt: number
}

/**
 * 全局传输队列：每 session 并发 N + 全局并发 M（可配）。
 * 目录任务渐进式展开（边 walk 边入队），避免十万文件一次性建树卡死。
 * 队列不跨应用重启持久化（.part 机制让重新入队的任务能自动续上）。
 */
class TransferQueue {
  private readonly entries = new Map<TaskId, Entry>()
  private readonly runningBySession = new Map<SessionId, number>()
  private running = 0
  /** 等着发的状态变更（见 publish/flushStates） */
  private readonly pendingStates = new Set<TaskId>()
  private stateFlushTimer: NodeJS.Timeout | null = null
  /**
   * 上传任务的"分类/展开"队列。**与传输并发完全分开**。
   *
   * 展开上传目录只需要读本地 fs（软链判定、readdir），不需要传输句柄，
   * 也就不该占 maxConcurrentPerSession 那 2 个名额 —— 以前它走 start() 全流程，
   * 于是深目录树上"展开"会被自己的传输饿住：越传越慢，越慢越发现不了新文件。
   */
  private readonly expandQueue: TaskId[] = []
  private expanding = 0
  private static readonly EXPAND_CONCURRENCY = 4

  list(): TransferTask[] {
    return [...this.entries.values()].map((e) => e.task)
  }

  enqueue(items: TransferEnqueueItem[]): TaskId[] {
    const ids: TaskId[] = []
    for (const item of items) {
      const parent = item.parentId ? (this.entries.get(item.parentId) ?? null) : null
      const task: TransferTask = {
        id: randomUUID(),
        sessionId: item.sessionId,
        kind: item.kind,
        localPath: item.kind === 'download' ? sanitizeDownloadPath(item.localPath) : item.localPath,
        remotePath: toRemotePath(item.remotePath),
        size: -1,
        transferred: 0,
        state: 'queued',
        speedBps: 0,
        createdAt: Date.now(),
        ...(parent ? { parentId: parent.task.id } : {}),
        // 子任务继承父任务的裁决：一棵树里深层文件与顶层守同一套语义
        ...(item.onConflict ? { onConflict: item.onConflict } : {})
      }
      const entry: Entry = {
        task,
        handle: null,
        attempted: false,
        // 上传要先过展开队列分类；下载的分类在 start 里做（要 SFTP）
        classified: item.kind === 'download',
        parent,
        children: [],
        depth: parent ? parent.depth + 1 : 0,
        rolledBytes: 0,
        lastReport: 0,
        lastBytes: 0,
        lastBytesAt: Date.now()
      }
      this.entries.set(task.id, entry)
      if (parent) {
        parent.children.push(entry)
        parent.task.childTotal = (parent.task.childTotal ?? 0) + 1
        this.publish(parent.task)
      }
      ids.push(task.id)

      /*
       * 入队前已探到远端同名、用户又选了"全部跳过"：就地落 skipped 终态。
       *
       * 不是"不入队"：用户选了 500 个文件、3 个撞名跳过，界面上出现 497 行而那 3 个
       * 无影无踪 —— 他会以为程序把文件吞了。以 skipped 出现在队列里，才是把
       * "按你说的跳过了这 3 个"说出来。也不开连接、不进任何队列。
       */
      if (item.skipExisting) {
        task.size = 0
        this.setState(entry, 'skipped')
        continue
      }

      this.publish(task)
      if (!entry.classified) this.expandQueue.push(task.id)
    }
    this.pumpExpand()
    this.pump()
    return ids
  }

  /**
   * 对一条任务施加操作。**目标是分组时级联到所有子孙。**
   *
   * 级联做在这里而不是新开一条 `transfer:controlGroup`：渲染进程不该为了选 channel
   * 先判断"这一行是不是分组"，那是个 bug 工厂；而且两条 channel 就要复制一遍 op 枚举。
   */
  control(taskId: TaskId, op: 'pause' | 'resume' | 'cancel' | 'retry'): void {
    const entry = this.entries.get(taskId)
    if (!entry) return
    // 从叶子往根做：分组的收尾判定要看到子任务**已经**改过状态，否则会先收一次假尾
    for (const target of this.selfAndDescendants(entry).reverse()) this.applyOp(target, op)
    if (op === 'resume' || op === 'retry') this.pumpExpand()
    this.pump()
  }

  /**
   * 整个队列一次。返回真的被动到的条数。
   *
   * 只对**顶层**任务下手：control 自己会级联到子孙，从根做一遍就覆盖全树，
   * 顺便避免同一条任务被作用两次（那会让"暂停"在中途被子任务的 resume 覆盖）。
   */
  controlAll(op: 'pause' | 'resume' | 'cancel'): number {
    const roots = [...this.entries.values()].filter((e) => !e.parent)
    let affected = 0
    for (const root of roots) {
      for (const target of this.selfAndDescendants(root).reverse()) {
        if (FINAL_STATES.has(target.task.state)) continue
        this.applyOp(target, op)
        affected += 1
      }
    }
    if (op !== 'cancel') this.pumpExpand()
    this.pump()
    return affected
  }

  /** 深度优先展平自己与所有子孙 */
  private selfAndDescendants(root: Entry): Entry[] {
    const out: Entry[] = []
    const stack = [root]
    while (stack.length > 0) {
      const e = stack.pop()!
      out.push(e)
      for (const c of e.children) stack.push(c)
    }
    return out
  }

  private applyOp(entry: Entry, op: 'pause' | 'resume' | 'cancel' | 'retry'): void {
    const { task } = entry

    if (op === 'pause') {
      if (task.state === 'running') entry.handle?.pause()
      else if (task.state === 'queued') this.setState(entry, 'paused')
      return
    }
    if (op === 'cancel') {
      if (task.state === 'running') entry.handle?.cancel()
      else if (!FINAL_STATES.has(task.state)) this.setState(entry, 'canceled')
      else if (task.isGroup) this.setState(entry, 'canceled')
      return
    }
    // resume / retry
    if (task.state === 'running') return
    task.error = undefined
    if (task.isGroup) {
      /*
       * 分组自己不搬字节，所以它的"重来"就是子任务重来（上面那趟已经级联到了）。
       * **不许让它再走一遍展开** —— 子任务已经在队列里，再展开一次就是整棵树翻倍。
       * settleGroup 收一次尾：没有子任务的（空目录）就地 done，有的等它们。
       */
      this.setState(entry, 'running')
      this.settleGroup(entry)
      return
    }
    this.setState(entry, 'queued')
    if (!entry.classified) this.expandQueue.push(task.id)
  }

  clearFinished(): void {
    for (const [id, entry] of [...this.entries]) {
      if (!FINAL_STATES.has(entry.task.state)) continue
      this.entries.delete(id)
      // 父子引用也要断，否则被清掉的条目还挂在父亲的 children 上，分组计数就错了
      const parent = entry.parent
      if (parent) {
        parent.children = parent.children.filter((c) => c !== entry)
        parent.task.childTotal = Math.max(0, (parent.task.childTotal ?? 1) - 1)
      }
      for (const child of entry.children) child.parent = null
    }
  }

  /** 会话关闭：其队列中的任务全部作废 */
  cancelForSession(sessionId: SessionId): void {
    for (const entry of this.entries.values()) {
      if (entry.task.sessionId !== sessionId) continue
      if (entry.task.state === 'running') entry.handle?.cancel()
      else if (entry.task.state === 'queued' || entry.task.state === 'paused') {
        this.setState(entry, 'canceled')
      }
    }
  }

  /**
   * 整个队列作废。
   *
   * `queued`/`paused` 也要砍：两个调用点（before-quit、装更新前）都表示"这就下去了"，
   * 留几万条 queued 是纯粹的错账 —— 而且批量上传之后"几万条"是真会发生的量。
   */
  cancelAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.task.state === 'running') entry.handle?.cancel()
      else if (!FINAL_STATES.has(entry.task.state)) this.setState(entry, 'canceled')
    }
    this.expandQueue.length = 0
  }

  // ---------------- 调度 ----------------

  private pump(): void {
    const settings = getSettings().sftp
    for (const entry of this.entries.values()) {
      if (entry.task.state !== 'queued') continue
      // 还没分类的上传任务不许开跑 —— 它可能是个目录，得先展开
      if (!entry.classified) continue
      if (this.running >= settings.maxConcurrentGlobal) return
      const perSession = this.runningBySession.get(entry.task.sessionId) ?? 0
      if (perSession >= settings.maxConcurrentPerSession) continue
      void this.start(entry)
    }
  }

  /** 展开队列的调度。只读本地 fs，闸门是自己的，与 running/runningBySession 无关 */
  private pumpExpand(): void {
    while (this.expanding < TransferQueue.EXPAND_CONCURRENCY && this.expandQueue.length > 0) {
      const id = this.expandQueue.shift()!
      const entry = this.entries.get(id)
      if (!entry || entry.task.state !== 'queued') continue
      this.expanding += 1
      void this.expandUpload(entry).finally(() => {
        this.expanding = Math.max(0, this.expanding - 1)
        this.pumpExpand()
        this.pump()
      })
    }
  }

  /**
   * 上传任务的分类与目录展开。**这个方法里绝不许出现 acquireTransferSftp** ——
   * 那正是它从 start() 里搬出来的全部理由（见 expandQueue 的说明）。
   *
   * 需要 SFTP 的只有一处：空目录得在远端如实建出来。那用**浏览**句柄
   * （mkdir 本来就是浏览类操作，`sftp:mkdir` 走的就是它，而且那条连接本来就是活的），
   * 于是这里依然不碰传输额度。
   */
  private async expandUpload(entry: Entry): Promise<void> {
    const { task } = entry
    /*
     * lstat 而不是 stat：stat 会跟随软链接，于是一条指向祖先目录的链接会被当成
     * 真目录展开下去 —— 表现是磁盘被写满/任务无限增长。
     */
    const stat = await fs.lstat(longPath(task.localPath)).catch(() => null)
    if (!stat) {
      task.error = `本地文件不存在：${task.localPath}`
      this.setState(entry, 'error')
      return
    }

    if (stat.isSymbolicLink()) {
      task.skippedLinks = 1
      task.size = 0
      this.setState(entry, 'done')
      return
    }

    if (!stat.isDirectory()) {
      this.setLeafSize(entry, stat.size)
      entry.classified = true
      this.publish(task)
      return
    }

    // ---- 目录 ----
    task.isGroup = true
    task.size = 0
    entry.classified = true
    if (entry.depth >= EXPAND_MAX_DEPTH) {
      task.error = `目录层级超过 ${EXPAND_MAX_DEPTH} 层，已停止展开（可能有循环链接）`
      this.setState(entry, 'error')
      return
    }
    if (this.entries.size >= EXPAND_MAX_TASKS) {
      task.error = `队列已达 ${EXPAND_MAX_TASKS} 条上限，已停止展开`
      this.setState(entry, 'error')
      return
    }

    this.setState(entry, 'running')
    this.setPhase(entry, 'scanning')
    const children = await fs
      .readdir(longPath(task.localPath), { withFileTypes: true })
      .catch(() => null)
    if (!children) {
      task.error = `无法读取目录：${task.localPath}`
      task.phase = undefined
      this.setState(entry, 'error')
      return
    }
    if (task.state === 'canceled') return

    const links = children.filter((c) => c.isSymbolicLink()).length
    const kept = children.filter((c) => !c.isSymbolicLink())
    if (links > 0) task.skippedLinks = (task.skippedLinks ?? 0) + links

    /*
     * 空目录（或者只剩软链接的目录）：远端如实建出来。
     *
     * 修的是一个静默丢数据的既有 bug —— 展开出 0 个子任务、父任务立刻 done，
     * 而远端 mkdirp 只在 worker 传文件时才被调，于是空目录在目标机上根本不存在。
     * 需要 mkdir 的次数与空目录数成正比、与树规模无关（有文件的目录由 worker 顺手建）。
     */
    if (kept.length === 0) {
      try {
        const sftp = await sshManager.get(task.sessionId).browseSftpSession()
        await mkdirp(sftp, toRemotePath(task.remotePath))
      } catch (err) {
        task.error = err instanceof Error ? err.message : String(err)
        task.phase = undefined
        this.setState(entry, 'error')
        return
      }
    }

    task.phase = undefined
    this.enqueue(
      kept.map((child) => ({
        sessionId: task.sessionId,
        kind: 'upload' as const,
        localPath: join(task.localPath, child.name),
        remotePath: remoteJoin(toRemotePath(task.remotePath), child.name),
        parentId: task.id,
        // 继承裁决：一棵树里深层文件与顶层守同一套语义。漏了它，用户对目录选的
        // "全部跳过"只作用在目录本身，里面的文件照旧覆盖 —— 而且没有任何提示
        onConflict: task.onConflict
      }))
    )
    // 子任务已全部入队（childTotal 定了），可能它们已经跑完了 —— 这一下负责收尾
    this.settleGroup(entry)
  }

  /**
   * 分组任务的收尾判定。
   *
   * 与旧行为的关键区别：父任务**不再一入队完子任务就 done**。它活到最后一个子孙
   * 进终态为止 —— 没有这一条，界面上就没法显示"这个目录 3/800"，而那正是批量上传
   * 最需要的一行信息。
   */
  private settleGroup(entry: Entry): void {
    const { task } = entry
    if (!task.isGroup) return
    if (task.state === 'canceled') return
    const total = task.childTotal ?? 0
    const finished = entry.children.filter((c) => FINAL_STATES.has(c.task.state)).length
    // 跳过的算"完成"（它是用户要的结果），但另记一笔，好在界面上说清楚
    task.childDone = entry.children.filter(
      (c) => c.task.state === 'done' || c.task.state === 'skipped'
    ).length
    task.childFailed = entry.children.filter((c) => c.task.state === 'error').length
    task.childSkipped = entry.children.filter((c) => c.task.state === 'skipped').length
    if (finished < total) {
      this.publish(task)
      return
    }
    const failed = task.childFailed ?? 0
    if (failed > 0) {
      task.error = `${failed} 个文件失败`
      this.setState(entry, 'error')
    } else {
      this.setState(entry, 'done')
    }
    // 往上再报一层由 setState 统一负责（那是所有终态迁移的唯一出口）
  }

  /** 子孙的字节增量沿父链累加。必须增量 —— 全表扫描在几万条任务 × 10Hz 下会吃掉 main */
  private rollUpBytes(entry: Entry, deltaTransferred: number, deltaSize: number): void {
    for (let p = entry.parent; p; p = p.parent) {
      p.task.transferred += deltaTransferred
      p.task.size += deltaSize
      this.publish(p.task)
    }
  }

  /** 把这条任务自上次以来新增的字节报给祖先。没有祖先时是纯赋值，开销可忽略 */
  private syncRolledBytes(entry: Entry): void {
    if (!entry.parent) return
    const delta = entry.task.transferred - entry.rolledBytes
    if (delta === 0) return
    entry.rolledBytes = entry.task.transferred
    this.rollUpBytes(entry, delta, 0)
  }

  private async start(entry: Entry): Promise<void> {
    const { task } = entry
    this.setState(entry, 'running')
    this.running += 1
    this.runningBySession.set(task.sessionId, (this.runningBySession.get(task.sessionId) ?? 0) + 1)

    let conn
    let sftp: SFTPWrapper | null = null
    try {
      conn = sshManager.get(task.sessionId)
      sftp = await conn.acquireTransferSftp()

      /*
       * 打包传输的接入点：**排在 expandIfDirectory 之前** —— 展开正是打包要替代的那一步，
       * 而此刻传输 SFTP 句柄已经活了（打包的 exec 就搭在同一条连接上，见 execChannel 的说明）。
       * 判定不成立时一个字节都没发出去，原路走下面那条既有路径，一行没改。
       */
      if (await this.tryPackedDownload(entry, conn, sftp)) {
        this.setState(entry, 'done')
        return
      }

      /*
       * 目录任务：展开为子任务。**不再立刻置 done** —— 它要活到最后一个子孙进终态，
       * 界面上才有"这个目录 3/800"这一行；settleGroup 负责收尾（子任务已全部入队，
       * 也可能已经跑完了，所以这里必须调一次）。
       */
      if (await this.expandIfDirectory(entry, sftp)) {
        this.settleGroup(entry)
        return
      }

      const resume = await this.resolveResume(entry, sftp)
      const { promise, handle } = runTransfer({
        sftp,
        task,
        resume,
        onProgress: (transferred) => this.reportProgress(entry, transferred),
        // 落地名被竞态改掉了：发布权仍在队列手里，worker 只报事实
        onLanded: (remotePath) => {
          task.remotePath = remotePath
          this.publish(task)
        }
      })
      entry.handle = handle
      entry.attempted = true
      await promise
      task.transferred = task.size >= 0 ? task.size : task.transferred
      // 最后那一截（节流窗口里没报出去的）也要计入祖先，否则分组进度差最后几 KB
      this.syncRolledBytes(entry)
      this.setState(entry, 'done')
    } catch (err) {
      if (err instanceof TransferAborted) {
        const next =
          err.kind === 'paused' ? 'paused' : err.kind === 'skipped' ? 'skipped' : 'canceled'
        if (next === 'skipped') task.notice = '远端已存在同名项，已按你的选择跳过'
        this.setState(entry, next)
      } else {
        task.error = err instanceof Error ? err.message : String(err)
        log.warn(`task ${task.id} failed: ${task.error}`)
        this.setState(entry, 'error')
      }
    } finally {
      entry.handle = null
      this.running = Math.max(0, this.running - 1)
      const perSession = (this.runningBySession.get(task.sessionId) ?? 1) - 1
      if (perSession <= 0) this.runningBySession.delete(task.sessionId)
      else this.runningBySession.set(task.sessionId, perSession)
      if (sftp) conn?.releaseTransferSftp()
      this.pump()
    }
  }

  /**
   * 打包下载：成立就整条任务在这里跑完（返回 true），不成立返回 false 让调用方走既有路径。
   *
   * 只对**下载目录**生效。上传方向（3c）另有一条必须先做的权限归一化，没有它不许发；
   * 单个文件永不打包 —— 多一份远端副本、多两次 tar，省下 0 个往返。
   *
   * 降级一律**静默但可解释**：原因落进 task.notice，界面显示为一行弱化文字。
   * "为什么这次没走打包"是这个功能最常被问的问题，静默且无解释会让人以为它没生效。
   */
  private async tryPackedDownload(
    entry: Entry,
    conn: SshConnection,
    sftp: SFTPWrapper
  ): Promise<boolean> {
    const { task } = entry
    if (task.kind !== 'download') return false
    if (!getSettings().sftp.packedTransfer) return false

    const remote = toRemotePath(task.remotePath)
    const info = await statSize(sftp, remote)
    if (!info.exists) throw new Error(`远端文件不存在：${remote}`)
    if (!info.isDir) return false

    this.setPhase(entry, 'scanning')
    const decision = await planPackedDownload({
      conn: conn.transferExecTarget(),
      sessionId: task.sessionId,
      dir: remote,
      localPath: task.localPath,
      conflictPolicy: getSettings().sftp.conflictPolicy
    }).catch((err: unknown) => {
      // 判定本身出错绝不能把传输带下去 —— 退回逐文件，把原因说出来
      log.warn(`pack decision failed: ${err instanceof Error ? err.message : String(err)}`)
      return { pack: false, reason: '打包判定未完成，已改用逐文件传输' } as PackDecision
    })

    if (!decision.pack) {
      task.phase = undefined
      task.notice = decision.reason
      this.publish(task)
      return false
    }

    task.packed = true
    const run = runPackedDownload({
      conn: conn.transferExecTarget(),
      sftp,
      task,
      tmpBase: decision.tmpBase as RemotePath,
      sizeKb: decision.sizeKb ?? 0,
      localTmpDir: packTempDir(),
      onProgress: (transferred) => this.reportProgress(entry, transferred),
      onPhase: (phase, notice) => this.setPhase(entry, phase, notice)
    })
    entry.handle = run.handle
    entry.attempted = true
    await run.promise
    task.phase = undefined
    task.transferred = task.size >= 0 ? task.size : task.transferred
    return true
  }

  private setPhase(entry: Entry, phase: TransferPhase, notice?: string): void {
    entry.task.phase = phase
    if (notice !== undefined) entry.task.notice = notice
    this.publish(entry.task)
  }

  /**
   * 远端目录 → 渐进式展开为文件子任务；返回 true 表示本任务是目录。
   *
   * **只剩下载方向。** 上传方向搬去了 expandUpload（见那里的说明：它只读本地 fs，
   * 不该占传输并发额度）。下载留在这里是因为远端 readdir 真的需要 SFTP 句柄，
   * 而且它**应该**被某个闸门限速。
   */
  private async expandIfDirectory(entry: Entry, sftp: SFTPWrapper): Promise<boolean> {
    const { task } = entry
    // 上传方向早在 expandUpload 里分好类了；让它走到下面那个 statSize 会报"远端文件不存在"
    if (task.kind !== 'download') return false
    const remote = toRemotePath(task.remotePath)
    const info = await statSize(sftp, remote)
    if (!info.exists) throw new Error(`远端文件不存在：${remote}`)
    if (!info.isDir) {
      this.setLeafSize(entry, info.size)
      return false
    }
    if (entry.depth >= EXPAND_MAX_DEPTH) {
      throw new Error(`目录层级超过 ${EXPAND_MAX_DEPTH} 层，已停止展开`)
    }
    task.isGroup = true
    task.size = 0
    const children = await readdirRaw(sftp, remote)
    // 空目录也要在本地如实建出来（与上传方向对称：不建就是静默少一个目录）
    await fs.mkdir(longPath(task.localPath), { recursive: true }).catch(() => undefined)
    this.enqueue(
      children.map((child) => ({
        sessionId: task.sessionId,
        kind: 'download' as const,
        localPath: join(task.localPath, sanitizeLocalName(child.filename)),
        remotePath: remoteJoin(remote, child.filename),
        parentId: task.id,
        onConflict: task.onConflict
      }))
    )
    return true
  }

  /** 叶子任务的 size 一确定就计入祖先总量（分组行的分母靠它长出来） */
  private setLeafSize(entry: Entry, size: number): void {
    entry.task.size = size
    if (size > 0) this.rollUpBytes(entry, 0, size)
  }

  /**
   * 是否走续传：只在"本任务此前跑过并被暂停/失败"时续传。
   * 首次执行一律从头开始（避免误接上别人留下的 .part）。
   */
  private async resolveResume(entry: Entry, sftp: SFTPWrapper): Promise<boolean> {
    if (!entry.attempted) return false
    const { task } = entry
    if (task.kind === 'download') {
      const partial = await fs.stat(longPath(`${task.localPath}.part`)).catch(() => null)
      return Boolean(partial && partial.size > 0)
    }
    const existing = await statSize(sftp, toRemotePath(`${task.remotePath}.ofspart`))
    return existing.exists && existing.size > 0
  }

  // ---------------- 事件 ----------------

  private reportProgress(entry: Entry, transferred: number): void {
    const now = Date.now()
    entry.task.transferred = transferred
    this.syncRolledBytes(entry)
    if (now - entry.lastReport < TRANSFER_PROGRESS_INTERVAL_MS) return
    /*
     * 进度事件不合批（它有自己的 200ms 节奏），所以有可能抢在这个任务的**首条**状态
     * 事件前面出去。渲染侧是按 id upsert 的，认不出的 id 会被静默丢掉 —— 那一行会有
     * 一小段显示 0 字节。这里先把积压的状态倒出去，顺序就对了。
     */
    if (this.pendingStates.has(entry.task.id)) this.flushStates()
    const elapsed = (now - entry.lastBytesAt) / 1000
    if (elapsed > 0) {
      entry.task.speedBps = Math.max(0, (transferred - entry.lastBytes) / elapsed)
      entry.lastBytes = transferred
      entry.lastBytesAt = now
    }
    entry.lastReport = now
    emit('transfer:progress', {
      taskId: entry.task.id,
      transferred,
      total: entry.task.size,
      speedBps: entry.task.speedBps
    })
  }

  private setState(entry: Entry, state: TransferTask['state']): void {
    entry.task.state = state
    if (state !== 'running') entry.task.speedBps = 0
    this.publish(entry.task)
    /*
     * 所有终态迁移的唯一出口，所以"通知父分组重算"挂在这里而不是散在各个调用点。
     * settleGroup 自己也走 setState，于是一路递归到根 —— 深度受 EXPAND_MAX_DEPTH 限。
     */
    if (FINAL_STATES.has(state) && entry.parent) this.settleGroup(entry.parent)
  }

  /**
   * 状态变更进合批缓冲。**缓的是 id，不是快照** —— 一个任务在展开高峰的 100ms 内
   * 可能走完 queued → running → done，缓 id 让它只发一份最终快照。
   */
  private publish(task: TransferTask): void {
    this.pendingStates.add(task.id)
    if (this.pendingStates.size >= TRANSFER_STATE_FLUSH_MAX) {
      this.flushStates()
      return
    }
    this.stateFlushTimer ??= setTimeout(() => this.flushStates(), TRANSFER_STATE_FLUSH_MS)
  }

  private flushStates(): void {
    if (this.stateFlushTimer) {
      clearTimeout(this.stateFlushTimer)
      this.stateFlushTimer = null
    }
    if (this.pendingStates.size === 0) return
    const tasks: TransferTask[] = []
    for (const id of this.pendingStates) {
      const entry = this.entries.get(id)
      // clearFinished 可能已经把它从 entries 里删掉了 —— 那就没什么可发的
      if (entry) tasks.push({ ...entry.task })
    }
    this.pendingStates.clear()
    if (tasks.length > 0) emit('transfer:states', { tasks })
  }
}

export const transferQueue = new TransferQueue()
