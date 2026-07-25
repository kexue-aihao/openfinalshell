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
}

interface SessionStore {
  tabs: SessionTab[]
  activeTabId: string | null
  setActiveTab: (id: string) => void
  /** 为 profile 开一个新 tab 并发起连接 */
  openForProfile: (profile: ConnectionProfile) => Promise<void>
  closeTab: (id: string) => Promise<void>
  renameTab: (id: string, title: string) => void
  updateTab: (id: string, patch: Partial<SessionTab>) => void
  /** TerminalPane 打开 shell 后回填 termId */
  bindTerm: (tabId: string, termId: TermId) => void
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  setActiveTab: (id) => set({ activeTabId: id }),

  openForProfile: async (profile) => {
    const tabId = crypto.randomUUID()
    const tab: SessionTab = {
      id: tabId,
      profileId: profile.id,
      sessionId: null,
      termId: null,
      title: profile.name,
      color: profile.color,
      state: 'connecting',
      sftpOpen: false,
      monitorOpen: false
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

  renameTab: (id, title) => get().updateTab(id, { customTitle: title }),

  updateTab: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

  bindTerm: (tabId, termId) => get().updateTab(tabId, { termId })
}))

let wired = false

/** 全局事件桥：session:state / term:exit → store（App 启动时调用一次） */
export function wireSessionEvents(): void {
  if (wired) return
  wired = true
  ofs.on('session:state', ({ sessionId, state, error }) => {
    const { tabs, updateTab } = useSessionStore.getState()
    for (const tab of tabs) {
      if (tab.sessionId === sessionId) {
        updateTab(tab.id, { state, error })
      }
    }
  })
  ofs.on('term:exit', ({ termId }) => {
    const { tabs, updateTab } = useSessionStore.getState()
    for (const tab of tabs) {
      if (tab.termId === termId) {
        updateTab(tab.id, { termId: null })
        // 会话仍 ready 而 shell 退出（用户敲 exit）→ 标记关闭态，浮层提供重连/关闭
        if (tab.state === 'ready') {
          updateTab(tab.id, { state: 'closed', error: '会话已结束' })
        }
      }
    }
  })
}
