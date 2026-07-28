import { create } from 'zustand'
import { COMMAND_HISTORY_MAX_CHARS } from '@shared/constants'
import type { CommandHistoryEntry } from '@shared/types'
import { ofs } from '@/ipc/api'

/**
 * 命令历史。**事实来源在 main 侧的 SQLite 表**，这里只是一份读缓存。
 *
 * `push` 是先改本地再发 IPC（乐观更新），理由是浮层的用途就是"刚才那条命令再来一遍" ——
 * 等一趟往返回来才出现，最需要它的那一刻它是空的。写失败也不回滚：那只意味着这一条
 * 没落库，下次 `load()` 自会对齐，而当场把用户眼前的列表抽掉一行更奇怪。
 */
interface HistoryStore {
  entries: CommandHistoryEntry[]
  loaded: boolean
  load: () => Promise<void>
  push: (command: string) => void
  clear: () => Promise<void>
}

export const useHistoryStore = create<HistoryStore>((set) => ({
  entries: [],
  loaded: false,

  load: async () => {
    const entries = await ofs.invoke('history:list')
    set({ entries, loaded: true })
  },

  push: (command) => {
    const trimmed = command.trim()
    /*
     * 判据必须与 main 侧那份**完全一致**（空 / 超长一律不记）。
     * 这里是乐观更新：本地先加一条再发 IPC，而 IPC 那侧的 zod 会把超长的拒掉 ——
     * 两边不一致的结果是列表里出现一条"库里其实没有"的记录，重启后凭空消失。
     */
    if (!trimmed || trimmed.length > COMMAND_HISTORY_MAX_CHARS) return
    set((s) => {
      const now = Date.now()
      const existing = s.entries.find((e) => e.command === trimmed)
      const rest = s.entries.filter((e) => e.command !== trimmed)
      return {
        entries: [
          {
            command: trimmed,
            lastUsedAt: now,
            useCount: (existing?.useCount ?? 0) + 1
          },
          ...rest
        ]
      }
    })
    void ofs.invoke('history:push', { command: trimmed }).catch(() => {})
  },

  clear: async () => {
    await ofs.invoke('history:clear')
    set({ entries: [] })
  }
}))

/** 子串过滤（大小写不敏感）。空关键词原样返回，不做拷贝 */
export function filterHistory(
  entries: CommandHistoryEntry[],
  keyword: string
): CommandHistoryEntry[] {
  const q = keyword.trim().toLowerCase()
  if (!q) return entries
  return entries.filter((e) => e.command.toLowerCase().includes(q))
}
