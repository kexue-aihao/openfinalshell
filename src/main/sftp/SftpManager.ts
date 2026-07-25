import type { SFTPWrapper } from 'ssh2'
import type { SessionId, SftpEntry } from '@shared/types'
import { sshManager } from '../ssh/SshConnectionManager'
import { toSftpEntry, typeFromMode, type RawDirEntry } from './entryParse'
import {
  remoteAncestors,
  remoteBasename,
  remoteJoin,
  toRemotePath,
  type RemotePath
} from './remotePath'

/** ssh2 的 sftp 回调风格 → Promise（有返回值） */
function promisify<T>(fn: (cb: (err: Error | undefined, result: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)))
  })
}

/** 只回错误的操作（mkdir/rename/unlink…）；ssh2 的 Callback 里 err 可能为 null */
function promisifyVoid(fn: (cb: (err: Error | null | undefined) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    fn((err) => (err ? reject(err) : resolve()))
  })
}

async function sftpOf(sessionId: SessionId): Promise<SFTPWrapper> {
  return sshManager.get(sessionId).browseSftpSession()
}

export async function readdir(sessionId: SessionId, path: string): Promise<SftpEntry[]> {
  const sftp = await sftpOf(sessionId)
  const dir = toRemotePath(path)
  const raw = await promisify<RawDirEntry[]>((cb) =>
    sftp.readdir(dir, cb as (err: Error | undefined, list: RawDirEntry[]) => void)
  )
  const entries = raw.map((r) => toSftpEntry(dir, r))

  // symlink 需要 follow stat 才知道指向文件还是目录（决定双击行为）
  await Promise.all(
    entries
      .filter((e) => e.type === 'symlink')
      .map(async (e) => {
        try {
          const attrs = await promisify<{ mode: number }>((cb) =>
            sftp.stat(e.path, cb as (err: Error | undefined, stats: { mode: number }) => void)
          )
          e.targetType = typeFromMode(attrs.mode)
        } catch {
          e.targetType = 'other' // 断链
        }
      })
  )
  return entries
}

export async function realpath(sessionId: SessionId, path: string): Promise<string> {
  const sftp = await sftpOf(sessionId)
  return promisify<string>((cb) =>
    sftp.realpath(path, cb as (err: Error | undefined, resolved: string) => void)
  )
}

export async function mkdir(sessionId: SessionId, path: string): Promise<void> {
  const sftp = await sftpOf(sessionId)
  await promisifyVoid((cb) => sftp.mkdir(toRemotePath(path), cb))
}

export async function rename(sessionId: SessionId, from: string, to: string): Promise<void> {
  const sftp = await sftpOf(sessionId)
  await promisifyVoid((cb) => sftp.rename(toRemotePath(from), toRemotePath(to), cb))
}

export async function chmod(sessionId: SessionId, path: string, mode: number): Promise<void> {
  const sftp = await sftpOf(sessionId)
  await promisifyVoid((cb) => sftp.chmod(toRemotePath(path), mode, cb))
}

/** 递归删除：深度优先，符号链接按自身删除（不跟随） */
export async function remove(sessionId: SessionId, path: string, recursive: boolean): Promise<void> {
  const sftp = await sftpOf(sessionId)
  const target = toRemotePath(path)
  const attrs = await promisify<{ mode: number }>((cb) =>
    sftp.lstat(target, cb as (err: Error | undefined, stats: { mode: number }) => void)
  )
  const type = typeFromMode(attrs.mode)

  if (type !== 'dir') {
    await promisifyVoid((cb) => sftp.unlink(target, cb))
    return
  }
  if (!recursive) {
    await promisifyVoid((cb) => sftp.rmdir(target, cb))
    return
  }

  const children = await promisify<RawDirEntry[]>((cb) =>
    sftp.readdir(target, cb as (err: Error | undefined, list: RawDirEntry[]) => void)
  )
  for (const child of children) {
    await remove(sessionId, remoteJoin(target, child.filename), true)
  }
  await promisifyVoid((cb) => sftp.rmdir(target, cb))
}

/** 传输前查看远端目标是否已存在（冲突策略判定用） */
export async function statSize(
  sftp: SFTPWrapper,
  path: RemotePath
): Promise<{ exists: boolean; size: number; isDir: boolean }> {
  try {
    const attrs = await promisify<{ mode: number; size: number }>((cb) =>
      sftp.stat(path, cb as (err: Error | undefined, stats: { mode: number; size: number }) => void)
    )
    return { exists: true, size: attrs.size, isDir: typeFromMode(attrs.mode) === 'dir' }
  } catch {
    return { exists: false, size: 0, isDir: false }
  }
}

/** 逐级 mkdir（SFTP 无 mkdir -p），已存在则忽略 */
export async function mkdirp(sftp: SFTPWrapper, dir: RemotePath): Promise<void> {
  for (const ancestor of remoteAncestors(dir)) {
    try {
      await promisifyVoid((cb) => sftp.mkdir(ancestor, cb))
    } catch {
      // 已存在或无权限 —— 后续写文件时会给出更准确的错误
    }
  }
}

export async function readdirRaw(sftp: SFTPWrapper, dir: RemotePath): Promise<RawDirEntry[]> {
  return promisify<RawDirEntry[]>((cb) =>
    sftp.readdir(dir, cb as (err: Error | undefined, list: RawDirEntry[]) => void)
  )
}

export { remoteBasename }
