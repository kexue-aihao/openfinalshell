import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { SessionId, TaskId, TransferEnqueueItem, TransferTask } from '@shared/types'
import { TRANSFER_PROGRESS_INTERVAL_MS } from '@shared/constants'
import { emit } from '../ipc/registry'
import { getSettings } from '../services/settings'
import { sshManager } from '../ssh/SshConnectionManager'
import { readdirRaw, statSize } from './SftpManager'
import { longPath, remoteJoin, sanitizeLocalName, toRemotePath } from './remotePath'
import { runTransfer, TransferAborted, type WorkerHandle } from './TransferWorker'
import { scopedLogger } from '../utils/logger'

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
        localPath: item.localPath,
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
