import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 原子写文件：写 *.tmp 后 rename 覆盖目标。
 * Windows 上 Node 的 rename 使用 MoveFileEx(REPLACE_EXISTING)，可覆盖已存在文件。
 * 同一路径的并发写入串行化，避免 tmp 文件互相踩踏。
 */
const pending = new Map<string, Promise<void>>()

export function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const prev = pending.get(filePath) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, data, 'utf8')
      await fs.rename(tmp, filePath)
    })
  pending.set(filePath, next)
  next.finally(() => {
    if (pending.get(filePath) === next) pending.delete(filePath)
  })
  return next
}
