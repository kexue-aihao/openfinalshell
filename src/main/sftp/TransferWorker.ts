import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { TransferTask } from '@shared/types'
import { mkdirp, statSize } from './SftpManager'
import { dedupeName, longPath, remoteDirname, toRemotePath, type RemotePath } from './remotePath'
import { sftpClose, sftpOpen, sftpRead, sftpWrite } from './sftpLowLevel'
import { effectiveAction } from './conflictPlan'
import { getSettings } from '../services/settings'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('transfer')

/**
 * 并发窗口参数。
 * 顺序 pipe（每块等一次 ACK）在高延迟链路上会被 RTT 打死 —— 实测 220ms RTT 的服务器上
 * 上传 0.16MB/s、下载 0.04MB/s（见 scripts/benchSftp.mjs）。这里改为同时在管道里
 * 保持多个读/写请求，参数与 ssh2 的 fastPut/fastGet 默认值一致。
 */
const CONCURRENCY = 64
const CHUNK_SIZE = 32 * 1024

const PART_SUFFIX_LOCAL = '.part'
const PART_SUFFIX_REMOTE = '.ofspart'

export interface WorkerHandle {
  /** 暂停（保留 .part 便于续传） */
  pause: () => void
  /** 取消（删除 .part） */
  cancel: () => void
}

interface RunOptions {
  sftp: SFTPWrapper
  task: TransferTask
  onProgress: (transferred: number) => void
  /**
   * 落地名与入队时算的不一样（撞上竞态、现场改名了）。
   * 与 onProgress 对称：worker 只报事实，改 task 与发布事件仍然归队列。
   */
  onLanded?: (remotePath: RemotePath) => void
  /** 冲突已在入队阶段裁决；resume=true 时从现有 .part 续传 */
  resume: boolean
}

/** 用于区分"被用户中止"与"真错误" */
export class TransferAborted extends Error {
  constructor(readonly kind: 'paused' | 'canceled' | 'skipped') {
    super(kind)
    this.name = 'TransferAborted'
  }
}

/**
 * 单任务执行器：并发窗口式读写（不用 fastGet/fastPut —— 它们无法中途暂停），
 * 自己控制请求发放即可兼得吞吐与可暂停。
 * 原子性：写 .part / .ofspart，完成后 rename 到最终名；中断绝不留半截的最终文件。
 */
export function runTransfer(opts: RunOptions): { promise: Promise<void>; handle: WorkerHandle } {
  const { sftp, task, onProgress, onLanded, resume } = opts
  const state = { paused: false, canceled: false }

  const handle: WorkerHandle = {
    pause: () => {
      state.paused = true
    },
    cancel: () => {
      state.canceled = true
    }
  }

  const promise = task.kind === 'download' ? download() : upload()

  /** 中止检查：暂停/取消都通过停止发放新请求来生效，不硬砍连接 */
  function abortIfRequested(): void {
    if (state.canceled) throw new TransferAborted('canceled')
    if (state.paused) throw new TransferAborted('paused')
  }

  async function upload(): Promise<void> {
    const remoteFinal = toRemotePath(task.remotePath)
    const remotePart = toRemotePath(`${remoteFinal}${PART_SUFFIX_REMOTE}`)
    await mkdirp(sftp, remoteDirname(remoteFinal))

    const localPath = longPath(task.localPath)
    const localStat = await fs.stat(localPath)
    const total = localStat.size
    // 上传文件的权限：SFTP open 不给 mode 时服务器会建出 0666（全局可写）。
    // Windows 的 stat.mode 是合成值（0666/0444），不能直接沿用，固定 0644；
    // POSIX 上按源文件权限走（保留可执行位）。
    const remoteMode = process.platform === 'win32' ? 0o644 : localStat.mode & 0o777
    let offset = 0
    if (resume) {
      const existing = await statSize(sftp, remotePart)
      // 只接受不超过源文件大小的续传点
      offset = existing.exists && existing.size <= total ? existing.size : 0
    } else {
      await removeRemoteQuietly(sftp, remotePart)
    }

    const localFh = await fs.open(localPath, 'r')
    let remoteHandle: Buffer | null = null
    let aborted: TransferAborted | null = null
    try {
      remoteHandle = await sftpOpen(sftp, remotePart, offset > 0 ? 'r+' : 'w', remoteMode)
      const rh = remoteHandle
      await runWindow({
        total,
        startOffset: offset,
        onProgress,
        transfer: async (chunkOffset, length) => {
          const buf = Buffer.allocUnsafe(length)
          const { bytesRead } = await localFh.read(buf, 0, length, chunkOffset)
          if (bytesRead === 0) return 0
          await sftpWrite(sftp, rh, chunkOffset, buf.subarray(0, bytesRead))
          return bytesRead
        },
        abortIfRequested
      })
    } catch (err) {
      // 中止交给下面统一处置（残留必须等句柄关了才能删）；真错误原样抛
      if (!(err instanceof TransferAborted)) throw err
      aborted = err
    } finally {
      await localFh.close()
      if (remoteHandle) await sftpClose(sftp, remoteHandle)
    }

    /*
     * 与 download 那边**对称**：取消要把远端的 .ofspart 收走，暂停要留着它续传 ——
     * WorkerHandle 上那两行注释一直是这么承诺的，而上传这条路以前只有一句裸的
     * abortIfRequested()，取消一次就在服务器上留一个 xxx.ofspart，且只有"下次重传
     * 且不续传"时才会被清掉，而任务被取消之后通常没有下一次。
     *
     * ⚠️ 上面那个 catch 不是可有可无的：中止是在 runWindow **内部**被发现的
     * （abortIfRequested 在循环顶上抛），于是异常会直接穿过这一段。以前这里的
     * `if (state.canceled)` 检查只在 runWindow 正常返回时才跑到 —— 也就是几乎跑不到，
     * 所以两个方向的 .part/.ofspart 清理实际上都是死代码。集成测试当时用
     * `if (task.state === 'canceled')` 包着断言，一直走的是 else 分支，看不出来。
     *
     * 删除必须在 finally 的 sftpClose **之后**：unlink 一个还开着的句柄在 POSIX 上
     * 能过，但写入未必已落盘，有的服务器直接拒。
     */
    if (state.canceled) {
      await removeRemoteQuietly(sftp, remotePart)
      throw new TransferAborted('canceled')
    }
    if (state.paused) throw new TransferAborted('paused')
    if (aborted) throw aborted

    /*
     * 落地。这里是 `TransferAborted` 上面那句"冲突已在入队阶段裁决"第一次成真的地方。
     *
     * 这一次 statSize 不是新增的往返 —— 它本来就在（SFTP rename 不覆盖，得先看目标在不在），
     * 现在顺便充当**竞态探测器**：入队时探过一遍，但那之后到落地之前，别人完全可能
     * 建出同名文件。三个分支都在这一次探测的结果上分岔，一个往返都没多花。
     */
    const action = effectiveAction(task.onConflict, getSettings().sftp.conflictPolicy)
    let landed = remoteFinal
    const existingFinal = await statSize(sftp, remoteFinal)
    if (existingFinal.exists) {
      if (action === 'skip') {
        // 整份都传完了才发现要跳过，那坨 .ofspart 是最大的一份残留，必须收走
        await removeRemoteQuietly(sftp, remotePart)
        throw new TransferAborted('skipped')
      }
      if (action === 'rename') landed = await freeRemoteName(sftp, remoteFinal)
      else await removeRemoteQuietly(sftp, remoteFinal)
    }
    await new Promise<void>((resolve, reject) => {
      sftp.rename(remotePart, landed, (err) => (err ? reject(err) : resolve()))
    })
    if (landed !== remoteFinal) onLanded?.(landed)
  }

  /**
   * 竞态兜底：目标被别人占了，按 dedupeName 的候选序找第一个空位。
   *
   * **只在真撞上的时候才付往返**（常规路径 0 次）。入队时算好的名字覆盖了绝大多数情况，
   * 这里处理的是"我们探测之后、落地之前，别人建了同名"这一小段窗口。
   */
  async function freeRemoteName(s: SFTPWrapper, target: RemotePath): Promise<RemotePath> {
    const dir = remoteDirname(target)
    const base = target.slice(target.lastIndexOf('/') + 1)
    const taken = new Set<string>([base])
    for (let i = 0; i < 20; i++) {
      const candidate = dedupeName(base, (c) => taken.has(c))
      const full = toRemotePath(dir === '/' ? `/${candidate}` : `${dir}/${candidate}`)
      if (!(await statSize(s, full)).exists) return full
      taken.add(candidate)
    }
    throw new Error(`远端已有太多同名文件，放弃重命名：${target}`)
  }

  async function download(): Promise<void> {
    const remote = toRemotePath(task.remotePath)
    const finalLocal = longPath(task.localPath)
    const partLocal = `${finalLocal}${PART_SUFFIX_LOCAL}`
    await fs.mkdir(dirname(finalLocal), { recursive: true })

    const info = await statSize(sftp, remote)
    if (!info.exists) throw new Error(`远端文件不存在：${remote}`)
    const total = info.size

    let offset = 0
    if (resume) {
      const partial = await fs.stat(partLocal).catch(() => null)
      offset = partial && partial.size <= total ? partial.size : 0
    } else {
      await fs.rm(partLocal, { force: true })
    }

    const localFh = await fs.open(partLocal, offset > 0 ? 'r+' : 'w')
    let remoteHandle: Buffer | null = null
    let aborted: TransferAborted | null = null
    try {
      remoteHandle = await sftpOpen(sftp, remote, 'r')
      const rh = remoteHandle
      await runWindow({
        total,
        startOffset: offset,
        onProgress,
        transfer: async (chunkOffset, length) => {
          const buf = Buffer.allocUnsafe(length)
          const read = await sftpRead(sftp, rh, buf, length, chunkOffset)
          if (read === 0) return 0
          await localFh.write(buf, 0, read, chunkOffset)
          return read
        },
        abortIfRequested
      })
    } catch (err) {
      // 见 upload() 里那段说明：中止是在 runWindow 内部抛的，不接住就穿过下面的清理
      if (!(err instanceof TransferAborted)) throw err
      aborted = err
    } finally {
      await localFh.close()
      if (remoteHandle) await sftpClose(sftp, remoteHandle)
    }

    if (state.canceled) {
      await fs.rm(partLocal, { force: true })
      throw new TransferAborted('canceled')
    }
    if (state.paused) throw new TransferAborted('paused')
    if (aborted) throw aborted

    await fs.rm(finalLocal, { force: true })
    await fs.rename(partLocal, finalLocal)
  }

  return { promise, handle }
}

interface WindowOptions {
  total: number
  startOffset: number
  onProgress: (transferred: number) => void
  /** 传输一块，返回实际字节数（0 表示到达 EOF） */
  transfer: (offset: number, length: number) => Promise<number>
  abortIfRequested: () => void
}

/**
 * 并发窗口调度：始终让管道里保持最多 CONCURRENCY 个在途请求。
 * 暂停/取消时停止发放新请求，但等在途请求自然结束 —— 保证 .part 里的数据是连续可续传的。
 */
async function runWindow(opts: WindowOptions): Promise<void> {
  const { total, startOffset, onProgress, transfer, abortIfRequested } = opts
  let nextOffset = startOffset
  let transferred = startOffset
  let eof = false
  let firstError: unknown = null
  let stopIssuing = false
  const inFlight = new Set<Promise<void>>()

  onProgress(transferred)

  const issue = (): void => {
    const offset = nextOffset
    const length = Math.min(CHUNK_SIZE, total - offset)
    if (length <= 0) {
      eof = true
      return
    }
    nextOffset += length
    const p = transfer(offset, length)
      .then((bytes) => {
        if (bytes === 0) {
          eof = true
          return
        }
        transferred += bytes
        onProgress(transferred)
      })
      .catch((err) => {
        firstError ??= err
        stopIssuing = true
      })
      .finally(() => {
        inFlight.delete(p)
      })
    inFlight.add(p)
  }

  while (!eof && !stopIssuing) {
    try {
      abortIfRequested()
    } catch (err) {
      firstError ??= err
      stopIssuing = true
      break
    }
    while (inFlight.size < CONCURRENCY && !eof && !stopIssuing) issue()
    if (inFlight.size === 0) break
    await Promise.race(inFlight)
  }

  // 等在途请求收尾，避免 .part 出现空洞
  while (inFlight.size > 0) await Promise.race(inFlight)
  if (firstError) throw firstError
}

/**
 * 删除失败照常继续：调用点都是"清掉可能存在的残留 .part / 待覆盖的目标"，
 * 目标本来就不一定存在；真的是权限问题的话，紧接着的 open/rename 会报出来。
 */
async function removeRemoteQuietly(sftp: SFTPWrapper, path: string): Promise<void> {
  await new Promise<void>((resolve) => {
    sftp.unlink(path, (err) => {
      if (err) log.debug(`unlink ${path} failed: ${err.message}`)
      resolve()
    })
  })
}
