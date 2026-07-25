import { create } from 'zustand'
import type { Snippet, SnippetGroup } from '@shared/types'
import { ofs } from '@/ipc/api'

const HISTORY_LIMIT = 50

interface SnippetStore {
  groups: SnippetGroup[]
  snippets: Snippet[]
  loaded: boolean
  /** 本地命令历史（不持久化到 main） */
  history: string[]
  load: () => Promise<void>
  save: (snippet: Snippet) => Promise<void>
  remove: (id: string) => Promise<void>
  saveGroup: (group: SnippetGroup) => Promise<void>
  removeGroup: (id: string) => Promise<void>
  pushHistory: (command: string) => void
}

export const useSnippetStore = create<SnippetStore>((set, get) => ({
  groups: [],
  snippets: [],
  loaded: false,
  history: [],

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
  },

  pushHistory: (command) =>
    set((s) => ({ history: [command, ...s.history.filter((c) => c !== command)].slice(0, HISTORY_LIMIT) }))
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
