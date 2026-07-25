import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { TransferTask } from '@shared/types'
import { mkdirp, statSize } from './SftpManager'
import { longPath, remoteDirname, toRemotePath } from './remotePath'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('transfer')
const CHUNK_SIZE = 64 * 1024
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
  /** 冲突已在入队阶段裁决；resume=true 时从现有 .part 续传 */
  resume: boolean
}

/**
 * 单任务执行器：流式 pipe（不用 fastGet/fastPut —— 后者无法中途暂停，
 * 且并发乱序写对部分非 OpenSSH 的 sftp-server 会损坏文件）。
 * 原子性：写 .part / .ofspart，完成后 rename 到最终名。
 */
export function runTransfer(
  opts: RunOptions
): { promise: Promise<void>; handle: WorkerHandle } {
  const { sftp, task, onProgress, resume } = opts
  let canceled = false
  let paused = false
  let cleanup: (() => void) | null = null

  const handle: WorkerHandle = {
    pause: () => {
      paused = true
      cleanup?.()
    },
    cancel: () => {
      canceled = true
      cleanup?.()
    }
  }

  const promise = (async (): Promise<void> => {
    if (task.kind === 'download') {
      await download()
    } else {
      await upload()
    }
  })()

  async function download(): Promise<void> {
    const remote = toRemotePath(task.remotePath)
    const finalLocal = longPath(task.localPath)
    const partLocal = `${finalLocal}${PART_SUFFIX_LOCAL}`
    await fs.mkdir(dirname(finalLocal), { recursive: true })

    let offset = 0
    if (resume) {
      try {
        offset = (await fs.stat(partLocal)).size
      } catch {
        offset = 0
      }
    } else {
      await fs.rm(partLocal, { force: true })
    }

    let transferred = offset
    onProgress(transferred)

    await new Promise<void>((resolve, reject) => {
      const readStream = sftp.createReadStream(remote, { start: offset, highWaterMark: CHUNK_SIZE })
      const writeStream = createWriteStream(partLocal, { flags: offset > 0 ? 'a' : 'w' })
      cleanup = () => {
        readStream.destroy()
        writeStream.destroy()
      }
      readStream.on('data', (chunk: Buffer | string) => {
        transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        onProgress(transferred)
      })
      readStream.on('error', reject)
      writeStream.on('error', reject)
      writeStream.on('finish', resolve)
      readStream.pipe(writeStream)
    })

    if (canceled) {
      await fs.rm(partLocal, { force: true })
      throw new TransferAborted('canceled')
    }
    if (paused) throw new TransferAborted('paused')

    await fs.rm(finalLocal, { force: true })
    await fs.rename(partLocal, finalLocal)
  }

  async function upload(): Promise<void> {
    const remoteFinal = toRemotePath(task.remotePath)
    const remotePart = toRemotePath(`${remoteFinal}${PART_SUFFIX_REMOTE}`)
    await mkdirp(sftp, remoteDirname(remoteFinal))

    let offset = 0
    if (resume) {
      const existing = await statSize(sftp, remotePart)
      offset = existing.exists ? existing.size : 0
    }

    let transferred = offset
    onProgress(transferred)

    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(longPath(task.localPath), {
        start: offset,
        highWaterMark: CHUNK_SIZE
      })
      const writeStream = sftp.createWriteStream(remotePart, {
        flags: offset > 0 ? 'a' : 'w'
      })
      cleanup = () => {
        readStream.destroy()
        writeStream.destroy()
      }
      readStream.on('data', (chunk: Buffer | string) => {
        transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        onProgress(transferred)
      })
      readStream.on('error', reject)
      writeStream.on('error', reject)
      writeStream.on('close', resolve)
      readStream.pipe(writeStream)
    })

    if (canceled) {
      await removeRemoteQuietly(sftp, remotePart)
      throw new TransferAborted('canceled')
    }
    if (paused) throw new TransferAborted('paused')

    // 目标已存在时先删再 rename（SFTP rename 不覆盖）
    const existingFinal = await statSize(sftp, remoteFinal)
    if (existingFinal.exists) await removeRemoteQuietly(sftp, remoteFinal)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(remotePart, remoteFinal, (err) => (err ? reject(err) : resolve()))
    })
  }

  return { promise, handle }
}

async function removeRemoteQuietly(sftp: SFTPWrapper, path: string): Promise<void> {
  await new Promise<void>((resolve) => {
    sftp.unlink(path, (err) => {
      if (err) log.debug(`unlink ${path} failed: ${err.message}`)
      resolve()
    })
  })
}

/** 用于区分"被用户中止"与"真错误" */
export class TransferAborted extends Error {
  constructor(readonly kind: 'paused' | 'canceled') {
    super(kind)
    this.name = 'TransferAborted'
  }
}
