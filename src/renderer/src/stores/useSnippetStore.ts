import { create } from 'zustand'
import type { Snippet, SnippetGroup } from '@shared/types'
import { ofs } from '@/ipc/api'

/**
 * ⚠️ 命令历史**不在这里**。它曾经是这个 store 里一个纯内存的 `history: string[]`，
 * 只装"从快捷命令面板点出去的命令"、不落库、重启清零 —— 那份实现已经删掉，
 * 换成 useHistoryStore（main 侧 SQLite 落库，且包含终端里手敲的命令）。
 * 别再往这里加第二份历史：两份历史意味着面板与浮层显示的东西迟早不一样。
 */
interface SnippetStore {
  groups: SnippetGroup[]
  snippets: Snippet[]
  loaded: boolean
  load: () => Promise<void>
  save: (snippet: Snippet) => Promise<void>
  remove: (id: string) => Promise<void>
  saveGroup: (group: SnippetGroup) => Promise<void>
  removeGroup: (id: string) => Promise<void>
}

export const useSnippetStore = create<SnippetStore>((set, get) => ({
  groups: [],
  snippets: [],
  loaded: false,

  load: async () => {
    const { groups, snippets } = await ofs.invoke('snippet:list')
    set({ groups, snippets, loaded: true })
  },

  save: async (snippet) => {
    await ofs.invoke('snippet:save', snippet)
    await get().load()
  },

  remove: async (id) => {
    await ofs.invoke('snippet:delete', id)
    await get().load()
  },

  saveGroup: async (group) => {
    await ofs.invoke('snippetGroup:save', group)
    await get().load()
  },

  removeGroup: async (id) => {
    await ofs.invoke('snippetGroup:delete', id)
    await get().load()
  }
}))

/** 展开 {{host}} / {{user}} / {{port}} 占位符 */
export function expandSnippet(
  command: string,
  ctx: { host?: string; user?: string; port?: number }
): string {
  return command
    .replace(/\{\{\s*host\s*\}\}/g, ctx.host ?? '')
    .replace(/\{\{\s*user\s*\}\}/g, ctx.user ?? '')
    .replace(/\{\{\s*port\s*\}\}/g, ctx.port === undefined ? '' : String(ctx.port))
}
