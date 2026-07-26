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
import { TRANSFER_PROGRESS_INTERVAL_MS } from '@shared/constants'
import { emit } from '../ipc/registry'
import { getSettings } from '../services/settings'
import type { SshConnection } from '../ssh/SshConnection'
import { sshManager } from '../ssh/SshConnectionManager'
import { planPackedDownload, runPackedDownload, type PackDecision } from './packTransfer'
import { readdirRaw, statSize } from './SftpManager'
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

interface Entry {
  task: TransferTask
  handle: WorkerHandle | null
  /** 该任务已跑过一次（暂停后继续 → 走续传） */
  attempted: boolean
  /** 目录任务：展开子任务用 */
  expandOnly: boolean
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

  list(): TransferTask[] {
    return [...this.entries.values()].map((e) => e.task)
  }

  enqueue(items: TransferEnqueueItem[]): TaskId[] {
    const ids: TaskId[] = []
    for (const item of items) {
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
        createdAt: Date.now()
      }
      this.entries.set(task.id, {
        task,
        handle: null,
        attempted: false,
        expandOnly: false,
        lastReport: 0,
        lastBytes: 0,
        lastBytesAt: Date.now()
      })
      ids.push(task.id)
      this.publish(task)
    }
    this.pump()
    return ids
  }

  control(taskId: TaskId, op: 'pause' | 'resume' | 'cancel' | 'retry'): void {
    const entry = this.entries.get(taskId)
    if (!entry) return
    const { task } = entry

    if (op === 'pause') {
      if (task.state === 'running') entry.handle?.pause()
      else if (task.state === 'queued') this.setState(entry, 'paused')
      return
    }
    if (op === 'cancel') {
      if (task.state === 'running') entry.handle?.cancel()
      else this.setState(entry, 'canceled')
      return
    }
    // resume / retry
    if (task.state === 'running') return
    task.error = undefined
    this.setState(entry, 'queued')
    this.pump()
  }

  clearFinished(): void {
    for (const [id, entry] of [...this.entries]) {
      if (['done', 'error', 'canceled'].includes(entry.task.state)) this.entries.delete(id)
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

  cancelAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.task.state === 'running') entry.handle?.cancel()
    }
  }

  // ---------------- 调度 ----------------

  private pump(): void {
    const settings = getSettings().sftp
    for (const entry of this.entries.values()) {
      if (entry.task.state !== 'queued') continue
      if (this.running >= settings.maxConcurrentGlobal) return
      const perSession = this.runningBySession.get(entry.task.sessionId) ?? 0
      if (perSession >= settings.maxConcurrentPerSession) continue
      void this.start(entry)
    }
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

      // 目录任务：展开为子任务后自身即完成
      if (await this.expandIfDirectory(entry, sftp)) {
        this.setState(entry, 'done')
        return
      }

      const resume = await this.resolveResume(entry, sftp)
      const { promise, handle } = runTransfer({
        sftp,
        task,
        resume,
        onProgress: (transferred) => this.reportProgress(entry, transferred)
      })
      entry.handle = handle
      entry.attempted = true
      await promise
      task.transferred = task.size >= 0 ? task.size : task.transferred
      this.setState(entry, 'done')
    } catch (err) {
      if (err instanceof TransferAborted) {
        this.setState(entry, err.kind === 'paused' ? 'paused' : 'canceled')
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

  /** 目录 → 渐进式展开为文件子任务；返回 true 表示本任务是目录 */
  private async expandIfDirectory(entry: Entry, sftp: SFTPWrapper): Promise<boolean> {
    const { task } = entry
    if (task.kind === 'upload') {
      const stat = await fs.stat(longPath(task.localPath)).catch(() => null)
      if (!stat) throw new Error(`本地文件不存在：${task.localPath}`)
      if (!stat.isDirectory()) {
        task.size = stat.size
        return false
      }
      const children = await fs.readdir(longPath(task.localPath), { withFileTypes: true })
      this.enqueue(
        children.map((child) => ({
          sessionId: task.sessionId,
          kind: 'upload' as const,
          localPath: join(task.localPath, child.name),
          remotePath: remoteJoin(toRemotePath(task.remotePath), child.name)
        }))
      )
      task.size = 0
      return true
    }

    const remote = toRemotePath(task.remotePath)
    const info = await statSize(sftp, remote)
    if (!info.exists) throw new Error(`远端文件不存在：${remote}`)
    if (!info.isDir) {
      task.size = info.size
      return false
    }
    const children = await readdirRaw(sftp, remote)
    this.enqueue(
      children.map((child) => ({
        sessionId: task.sessionId,
        kind: 'download' as const,
        localPath: join(task.localPath, sanitizeLocalName(child.filename)),
        remotePath: remoteJoin(remote, child.filename)
      }))
    )
    task.size = 0
    return true
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
    if (now - entry.lastReport < TRANSFER_PROGRESS_INTERVAL_MS) return
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
  }

  private publish(task: TransferTask): void {
    emit('transfer:state', { task: { ...task } })
  }
}

export const transferQueue = new TransferQueue()
