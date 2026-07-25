import { create } from 'zustand'
import type { ConnectionProfile, SessionId, SessionState, TermId } from '@shared/types'
import { ofs } from '@/ipc/api'

export interface SessionTab {
  id: string
  profileId: string
  sessionId: SessionId | null
  termId: TermId | null
  title: string
  customTitle?: string
  color?: string
  /** idle=尚未发起；其余同 SessionState */
  state: SessionState | 'idle'
  error?: string
  sftpOpen: boolean
  monitorOpen: boolean
  /** 递增计数：变化时 TerminalPane 重新开 shell（重连后复用同一 tab 与 xterm 缓冲） */
  shellEpoch: number
}

interface SessionStore {
  tabs: SessionTab[]
  activeTabId: string | null
  setActiveTab: (id: string) => void
  activateRelative: (delta: number) => void
  activateIndex: (index: number) => void
  openForProfile: (profile: ConnectionProfile) => Promise<void>
  duplicateTab: (id: string, profiles: ConnectionProfile[]) => Promise<void>
  closeTab: (id: string) => Promise<void>
  closeOthers: (id: string) => Promise<void>
  closeToRight: (id: string) => Promise<void>
  reconnectTab: (id: string) => Promise<void>
  renameTab: (id: string, title: string) => void
  updateTab: (id: string, patch: Partial<SessionTab>) => void
  bindTerm: (tabId: string, termId: TermId) => void
  toggleSftp: (id: string) => void
  toggleMonitor: (id: string) => void
}

/** 同名 tab 追加 (2)(3)… 便于区分复制出的会话 */
function uniqueTitle(tabs: SessionTab[], base: string): string {
  const taken = new Set(tabs.map((t) => t.customTitle ?? t.title))
  if (!taken.has(base)) return base
  for (let i = 2; i < 100; i++) {
    if (!taken.has(`${base} (${i})`)) return `${base} (${i})`
  }
  return base
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  setActiveTab: (id) => set({ activeTabId: id }),

  activateRelative: (delta) => {
    const { tabs, activeTabId } = get()
    if (tabs.length === 0) return
    const idx = tabs.findIndex((t) => t.id === activeTabId)
    const next = (((idx < 0 ? 0 : idx) + delta) % tabs.length + tabs.length) % tabs.length
    set({ activeTabId: tabs[next].id })
  },

  activateIndex: (index) => {
    const { tabs } = get()
    if (index >= 0 && index < tabs.length) set({ activeTabId: tabs[index].id })
  },

  openForProfile: async (profile) => {
    const tabId = crypto.randomUUID()
    const tab: SessionTab = {
      id: tabId,
      profileId: profile.id,
      sessionId: null,
      termId: null,
      title: uniqueTitle(get().tabs, profile.name),
      color: profile.color,
      state: 'connecting',
      sftpOpen: false,
      monitorOpen: false,
      shellEpoch: 0
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tabId }))
    try {
      const { sessionId } = await ofs.invoke('session:open', profile.id)
      get().updateTab(tabId, { sessionId })
    } catch (err) {
      get().updateTab(tabId, {
        state: 'closed',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },

  duplicateTab: async (id, profiles) => {
    const tab = get().tabs.find((t) => t.id === id)
    const profile = profiles.find((p) => p.id === tab?.profileId)
    if (profile) await get().openForProfile(profile)
  },

  closeTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null) : s.activeTabId
      return { tabs, activeTabId }
    })
    if (tab?.sessionId) {
      await ofs.invoke('session:close', tab.sessionId).catch(() => {})
    }
  },

  closeOthers: async (id) => {
    const others = get().tabs.filter((t) => t.id !== id)
    for (const t of others) await get().closeTab(t.id)
    set({ activeTabId: id })
  },

  closeToRight: async (id) => {
    const { tabs } = get()
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    for (const t of tabs.slice(idx + 1)) await get().closeTab(t.id)
  },

  reconnectTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    get().updateTab(id, { state: 'connecting', error: undefined })
    try {
      if (tab.sessionId) {
        await ofs.invoke('session:reconnect', tab.sessionId)
      } else {
        const { sessionId } = await ofs.invoke('session:open', tab.profileId)
        get().updateTab(id, { sessionId })
      }
    } catch (err) {
      get().updateTab(id, {
        state: 'closed',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },

  renameTab: (id, title) => get().updateTab(id, { customTitle: title }),

  updateTab: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

  bindTerm: (tabId, termId) => get().updateTab(tabId, { termId }),

  toggleSftp: (id) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sftpOpen: !t.sftpOpen } : t)) })),

  toggleMonitor: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, monitorOpen: !t.monitorOpen } : t))
    }))
}))

let wired = false

/** 全局事件桥：session:state / term:exit → store（App 启动时调用一次） */
export function wireSessionEvents(): void {
  if (wired) return
  wired = true

  ofs.on('session:state', ({ sessionId, state, error }) => {
    const { tabs, updateTab } = useSessionStore.getState()
    for (const tab of tabs) {
      if (tab.sessionId !== sessionId) continue
      updateTab(tab.id, { state, error })
      // 重连成功 → 让 TerminalPane 重开 shell（xterm 缓冲保留）
      if (state === 'ready' && tab.termId === null) {
        updateTab(tab.id, { shellEpoch: tab.shellEpoch + 1 })
      }
    }
  })

  ofs.on('term:exit', ({ termId, reason }) => {
    const { tabs, updateTab } = useSessionStore.getState()
    for (const tab of tabs) {
      if (tab.termId !== termId) continue
      updateTab(tab.id, { termId: null })
      // 连接仍在（用户敲 exit）→ 标记结束，浮层给重连/关闭；reconnected 由 session:state 驱动重开
      if (reason === 'closed' && tab.state === 'ready') {
        updateTab(tab.id, { state: 'closed', error: '会话已结束' })
      }
    }
  })
}
