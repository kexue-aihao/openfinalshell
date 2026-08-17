import type { SFTPWrapper } from 'ssh2'
import type { SftpEntry } from '@shared/types'
import { toSftpEntry, typeFromMode, type RawDirEntry } from './entryParse'
import type { RemotePath } from './remotePath'
import { t } from '../services/i18n'

/**
 * 目录列举：**自己开句柄、自己翻页**，为的是把 symlink 的 stat 塞进翻页的空档里。
 *
 * `sftp.readdir(路径字符串)` 那个便利形式内部就是 opendir → readdir 直到 EOF → close，
 * 但它**必须全部读完才回调**。于是原先的写法是：
 *
 *   [readdir 全部页] 全回来了 → 才开始发 symlink 的 stat → 再等一波 → 才回 IPC
 *
 * symlink 的那一波往返整整挂在关键路径末尾（`/etc`、`/usr/bin` 这种软链遍地的目录最明显）。
 * 自己翻页之后变成：
 *
 *   [opendir] → [第 1 页] → [第 2 页 ‖ 第 1 页的 stat] → [EOF ‖ 第 2 页的 stat] → 回 IPC
 *
 * 页 k 的 stat 与页 k+1 的 READDIR 同波飞行，stat 那一波基本被掩盖掉 —— 一次 cd 少两个往返。
 *
 * 三个不显眼但必须守住的点：
 *
 * 1. **空数组不是 EOF。** ssh2 会把 `.` 与 `..` 从每页里剔掉（SFTP.js 的 READDIR 处理），
 *    所以某一页恰好只有这两项时回来的就是 `[]`。把它当 EOF 会**静默截断目录** ——
 *    用户看到的是"这个目录里的东西少了一半"，而且不报错。EOF 只认服务器给的 EOF 状态。
 * 2. **句柄必须关，且不许 await 它。** browse 通道是整个会话复用的（SshConnection
 *    的 browseSftpSession），漏一个目录句柄就会往服务器的句柄配额上累加，配额耗尽之后
 *    每次 readdir 都回 FAILURE —— 而 cd 跟随那条路是 silentErrors，会把它全吞掉，
 *    表现成"过一阵子就又不跟随了"。而 await 它只是让用户多等一个往返看列表。
 * 3. **页数上限。** 便利形式里循环由 ssh2 管；自己翻页就得自己防"服务器永不给 EOF"，
 *    否则是一个无限 READDIR 循环（比原来单纯挂住更糟）。
 */

/** 每页 50~100 条是常见实现，2000 页足够 10 万条；到顶就是服务器不给 EOF */
const MAX_PAGES = 2000
/** 整体超时：逐页检查，不给单页设 —— 慢的是整次列举，不是某一页 */
const READDIR_DEADLINE_MS = 60_000

/** 取一页；返回 null 表示服务器给了 EOF（目录读完了） */
function readPage(sftp: SFTPWrapper, handle: Buffer): Promise<RawDirEntry[] | null> {
  return new Promise<RawDirEntry[] | null>((resolve, reject) => {
    sftp.readdir(handle, (err, list) => {
      if (err) {
        // 读完目录 ssh2 给 EOF(code 1)，与 sftpLowLevel 里读文件到尾同一条惯用法
        const code = (err as Error & { code?: number }).code
        if (code === 1 || /EOF/i.test(err.message)) return resolve(null)
        return reject(err)
      }
      resolve(list as unknown as RawDirEntry[])
    })
  })
}

/** 软链要 follow stat 才知道指向文件还是目录（决定双击行为）。**永不 reject** */
function resolveTargetType(sftp: SFTPWrapper, entry: SftpEntry): Promise<void> {
  return new Promise<void>((resolve) => {
    sftp.stat(entry.path, (err, attrs) => {
      // 断链（指向不存在的目标）是常态，不是错误
      entry.targetType = err ? 'other' : typeFromMode((attrs as unknown as { mode: number }).mode)
      resolve()
    })
  })
}

export async function readdirPaged(sftp: SFTPWrapper, dir: RemotePath): Promise<SftpEntry[]> {
  const handle = await new Promise<Buffer>((resolve, reject) => {
    sftp.opendir(dir, (err, h) => (err ? reject(err) : resolve(h)))
  })

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    try {
      // 回调里什么都不做：此刻唯一可能的错误是通道已经拆了，而那与用户无关
      sftp.close(handle, () => {})
    } catch {
      /* 通道已拆，close 可能同步抛 */
    }
  }

  const deadline = Date.now() + READDIR_DEADLINE_MS
  const entries: SftpEntry[] = []
  /** 已发出的 symlink stat。它们内部吞错，所以 Promise.all 不会 reject */
  const statJobs: Promise<void>[] = []

  try {
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        throw new Error(t('err.sftp.readdirTooManyPages', { path: dir }))
      }
      if (Date.now() > deadline) {
        throw new Error(t('err.sftp.readdirTimeout', { path: dir }))
      }
      const list = await readPage(sftp, handle)
      if (list === null) break // 服务器给了 EOF：读完了
      for (const raw of list) {
        const entry = toSftpEntry(dir, raw)
        entries.push(entry)
        // 立刻发出去，不 await —— 与下一页的 READDIR 同波飞行
        if (entry.type === 'symlink') statJobs.push(resolveTargetType(sftp, entry))
      }
    }
    await Promise.all(statJobs)
    return entries
  } finally {
    close()
  }
}
