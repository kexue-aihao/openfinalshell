import { app } from 'electron'
import { z } from 'zod'
import { handle } from './registry'
import { chmod, mkdir, readdir, realpath, remove, rename } from '../sftp/SftpManager'
import { transferQueue } from '../sftp/TransferQueue'

const sessionPath = z.object({ sessionId: z.string(), path: z.string().max(4096) })

export function registerSftpIpc(): void {
  handle('sftp:readdir', ({ sessionId, path }) => readdir(sessionId, path), z.tuple([sessionPath]))
  handle('sftp:realpath', ({ sessionId, path }) => realpath(sessionId, path), z.tuple([sessionPath]))
  handle('sftp:mkdir', ({ sessionId, path }) => mkdir(sessionId, path), z.tuple([sessionPath]))
  handle(
    'sftp:rename',
    ({ sessionId, from, to }) => rename(sessionId, from, to),
    z.tuple([z.object({ sessionId: z.string(), from: z.string().max(4096), to: z.string().max(4096) })])
  )
  handle(
    'sftp:delete',
    ({ sessionId, path, recursive }) => remove(sessionId, path, recursive),
    z.tuple([sessionPath.extend({ recursive: z.boolean() })])
  )
  handle(
    'sftp:chmod',
    ({ sessionId, path, mode }) => chmod(sessionId, path, mode),
    z.tuple([sessionPath.extend({ mode: z.number().int().min(0).max(0o7777) })])
  )

  handle(
    'transfer:enqueue',
    (items) =>
      transferQueue.enqueue(
        items.map((item) => ({
          ...item,
          // 未指定本地目标目录时落到系统下载目录
          localPath: item.localPath || app.getPath('downloads')
        }))
      ),
    z.tuple([
      z
        .array(
          z.object({
            sessionId: z.string(),
            kind: z.enum(['upload', 'download']),
            localPath: z.string().max(4096),
            remotePath: z.string().max(4096)
          })
        )
        .max(5000)
    ])
  )

  handle(
    'transfer:control',
    ({ taskId, op }) => transferQueue.control(taskId, op),
    z.tuple([
      z.object({ taskId: z.string(), op: z.enum(['pause', 'resume', 'cancel', 'retry']) })
    ])
  )

  handle('transfer:clearFinished', () => transferQueue.clearFinished())
  handle('transfer:list', () => transferQueue.list())
}
