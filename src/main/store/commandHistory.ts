import { COMMAND_HISTORY_MAX_CHARS, COMMAND_HISTORY_MAX_ROWS } from '@shared/constants'
import type { CommandHistoryEntry } from '@shared/types'
import { prepare, tx } from './Database'

/**
 * 命令历史的存储层。表定义在 Database.ts 的 SCHEMA 里 ——
 * 那份 SCHEMA 每次打开库都 `CREATE TABLE IF NOT EXISTS` 跑一遍，
 * 所以老用户的库**不需要迁移**，升级上来第一次启动表就在了。
 *
 * 三个语义决定都写在这里，因为它们各自都能被"顺手简化"掉：
 *
 * 1. **命令原文是主键**，所以 push 是 upsert。写成"每次 INSERT 一行、查询时
 *    `SELECT DISTINCT`"也能跑，但淘汰就废了：`MAX_ROWS` 会被同一条 `ls` 的
 *    一百次执行吃满，而列表里看起来只有一条。
 * 2. **淘汰在写入的同一个事务里**做。放到别处（定时、退出前）意味着崩溃/被强杀时不做，
 *    而这张表恰好是唯一一张会被高频写入的表。
 * 3. **入库前再卡一次长度**。IPC 那侧的 zod 已经卡过，这里不是重复劳动 ——
 *    exportData/importData 之外的第二个调用方（比如将来某处 main 自己想记一条）
 *    走不到那道校验，而"库里躺着一条 4MB 的记录"是不可逆的。
 */

/** 规范化：去掉首尾空白；空串或过长一律当"不该记"，返回 null */
export function normalizeCommand(command: string): string | null {
  const trimmed = command.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > COMMAND_HISTORY_MAX_CHARS) return null
  return trimmed
}

export function listCommandHistory(): CommandHistoryEntry[] {
  const rows = prepare(
    `SELECT command, last_used_at, use_count FROM command_history
     ORDER BY last_used_at DESC LIMIT ?`
  ).all(COMMAND_HISTORY_MAX_ROWS) as Array<{
    command: string
    last_used_at: number
    use_count: number
  }>
  return rows.map((r) => ({
    command: r.command,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count
  }))
}

/** 记一条（已存在则 use_count +1 并刷新时间）。返回是否真的写了 */
export function pushCommandHistory(command: string, now = Date.now()): boolean {
  const normalized = normalizeCommand(command)
  if (normalized === null) return false
  tx((conn) => {
    conn
      .prepare(
        `INSERT INTO command_history(command, last_used_at, use_count) VALUES(?, ?, 1)
         ON CONFLICT(command) DO UPDATE SET last_used_at = excluded.last_used_at,
                                           use_count = use_count + 1`
      )
      .run(normalized, now)
    /*
     * 淘汰：留最近的 MAX_ROWS 条。用子查询按 last_used_at 取要留的那批，
     * 而不是 `LIMIT -1 OFFSET n` 那种写法 —— 后者依赖 SQLite 的方言细节，
     * 而这条语句在 WAL 下每条命令都要跑一次，值得写得笨一点但一眼看得懂。
     */
    conn
      .prepare(
        `DELETE FROM command_history WHERE command NOT IN (
           SELECT command FROM command_history ORDER BY last_used_at DESC LIMIT ?
         )`
      )
      .run(COMMAND_HISTORY_MAX_ROWS)
  })
  return true
}

export function clearCommandHistory(): void {
  prepare('DELETE FROM command_history').run()
}
