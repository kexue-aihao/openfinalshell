import { create } from 'zustand'
import type { ConnectionProfile, SessionId, SessionState, TermId } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'
import i18n from '@/i18n'
import { ofs } from '@/ipc/api'
import { useSettingsStore } from './useSettingsStore'
import { useMonitorStore } from './useMonitorStore'
import { useEditorStore } from './useEditorStore'

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
  /** 曾经 ready 过：用于区分首次连接与重新建连，首连不打"连接已恢复"分隔线 */
  everReady?: boolean
}

interface SessionStore {
  tabs: SessionTab[]
  activeTabId: string | null
  setActiveTab: (id: string) => void
  activateRelative: (delta: number) => void
  activateIndex: (index: number) => void
  openForProfile: (profile: ConnectionProfile) => Promise<void>
  /**
   * 从连接树/最近列表"连接"的统一入口：按协议分派。
   * SSH → openForProfile（建会话 tab）；RDP → 交系统远程桌面，不建 tab。
   * 返回被走的分支，让调用方对 RDP 给一句"已在系统远程桌面打开"的反馈。
   */
  launchProfile: (profile: ConnectionProfile) => Promise<'ssh' | 'rdp'>
  duplicateTab: (id: string, profiles: ConnectionProfile[]) => Promise<void>
  closeTab: (id: string) => Promise<void>
  closeOthers: (id: string) => Promise<void>
  closeToRight: (id: string) => Promise<void>
  reconnectTab: (id: string) => Promise<void>
  renameTab: (id: string, title: string) => void
  updateTab: (id: string, patch: Partial<SessionTab>) => void
  /** tab 拿到 sessionId：补上开连期间错过的状态事件 */
  claimSession: (tabId: string, sessionId: SessionId) => void
  bindTerm: (tabId: string, termId: TermId) => void
  toggleSftp: (id: string) => void
  toggleMonitor: (id: string) => void
}

/**
 * sessionId → 最近一次状态，暂存"还没有 tab 认领"的会话。
 *
 * session:open 要等会话 ready 才 resolve，而 connecting / authenticating / ready
 * 这几个事件在那之前就由主进程发出去了。两者走的不是同一条路：
 * 事件是 webContents.send，应答是 invoke 的回包，**到达顺序没有保证**。
 *
 * 事件先到时，tab 的 sessionId 还是 null，按 id 匹配全部落空 ——
 * 于是 tab 永远停在 connecting：主进程明明连上了，界面一直转圈、终端也不开
 * （TerminalPane 等的就是 ready）。这就是 v0.1.1 那个"连不上"的真身，
 * 也解释了为什么它时好时坏：应答先到的那些时候，事件补上来反而正常了。
 *
 * 所以这里存下来等认领，而不是"resolve 了就当 ready" —— 两种顺序都要兜住。
 */
const unclaimedState = new Map<SessionId, { state: SessionState; error?: string }>()
/** session:open 失败的会话没人会来认领，留个上限免得这张表无限长 */
const UNCLAIMED_MAX = 32

function rememberUnclaimed(sessionId: SessionId, state: SessionState, error?: string): void {
  unclaimedState.set(sessionId, { state, error })
  for (const key of unclaimedState.keys()) {
    if (unclaimedState.size <= UNCLAIMED_MAX) break
    unclaimedState.delete(key)
  }
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
    // 设置可能还没加载完（init 是异步的），回退到默认值而不是当成 false
    const sftp = useSettingsStore.getState().settings?.sftp ?? DEFAULT_SETTINGS.sftp
    const tab: SessionTab = {
      id: tabId,
      profileId: profile.id,
      sessionId: null,
      termId: null,
      title: uniqueTitle(get().tabs, profile.name),
      color: profile.color,
      state: 'connecting',
      // 两个面板各归各家：SFTP 是全局偏好，监控是连接自己的属性
      // （低配服务器通道紧张时要能按连接关掉，而不是一刀切）
      sftpOpen: sftp.autoOpenOnConnect,
      monitorOpen: profile.options.monitorEnabled,
      shellEpoch: 0
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tabId }))
    try {
      const { sessionId } = await ofs.invoke('session:open', profile.id)
      get().claimSession(tabId, sessionId)
    } catch (err) {
      get().updateTab(tabId, {
        state: 'closed',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },

  launchProfile: async (profile) => {
    if (profile.protocol === 'rdp') {
      // 不建 tab、不开 SSH 会话：mstsc 是独立进程，凭据由系统接管
      await ofs.invoke('conn:launchRdp', profile.id)
      return 'rdp'
    }
    await get().openForProfile(profile)
    return 'ssh'
  },

  duplicateTab: async (id, profiles) => {
    const tab = get().tabs.find((t) => t.id === id)
    const profile = profiles.find((p) => p.id === tab?.profileId)
    if (profile) await get().openForProfile(profile)
  },

  closeTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    /**
     * 这个会话下有未保存的编辑就先问一句，而且**不看 confirmOnCloseTab 那个设置**：
     * 那个开关管的是"关一条连接要不要确认"，而这里要拦的是丢掉用户亲手打的字。
     * 一个把确认关掉的人想要的是"别拿连接烦我"，不是"删我改的东西也别问"。
     *
     * 用 window.confirm 而不是 antd 的 modal：这是个 store，没有 App 的上下文，
     * 而调进来的地方有四个（标签的 X、关闭其他、关闭右侧、Ctrl+W）——
     * 把确认放在每个调用点上迟早会漏掉一个。同一个理由下 useGlobalShortcuts
     * 里那句 confirmOnCloseTab 也是 window.confirm，形状一致。
     */
    if (tab?.sessionId && useEditorStore.getState().hasDirty(tab.sessionId)) {
      if (!window.confirm(i18n.t('editor.closeSessionDirty'))) return
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null) : s.activeTabId
      return { tabs, activeTabId }
    })
    if (tab?.sessionId) {
      // 不 clear 的话，关掉的会话在 useMonitorStore 里的快照与 60 点历史永不释放
      useMonitorStore.getState().clear(tab.sessionId)
      // 内置编辑器同理，而且更贵：每份正文最多 2MB（UTF-16 字符串就是 4MB），
      // 会话都关了还留着十份是纯粹的泄漏
      useEditorStore.getState().closeSession(tab.sessionId)
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
        get().claimSession(id, sessionId)
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

  claimSession: (tabId, sessionId) => {
    const pending = unclaimedState.get(sessionId)
    unclaimedState.delete(sessionId)
    // session:open 只在成功后 resolve，所以至少已经 ready 过；
    // 但开连到 resolve 之间可能又掉线了，那就用真实的最新状态，不能一律硬写 ready
    const state = pending?.state ?? 'ready'
    get().updateTab(tabId, {
      sessionId,
      state,
      error: pending?.error,
      ...(state === 'ready' ? { everReady: true } : {})
    })
  },

  bindTerm: (tabId, termId) => get().updateTab(tabId, { termId }),

  toggleSftp: (id) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sftpOpen: !t.sftpOpen } : t)) })),

  /**
   * 关掉监控必须同时停采集器。
   * 早先 stop 只写在 MainLayout.closeMonitor 里，而终端悬浮工具条那个按钮
   * 直接调 toggleMonitor —— 于是从工具条关面板时主进程仍在每 2s 轮询一整帧，
   * 一条泄漏的采集通道。自动打开会让它从"偶发"变成"每条会话都发生"。
   */
  toggleMonitor: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, monitorOpen: !t.monitorOpen } : t))
    }))
    if (tab?.monitorOpen && tab.sessionId) {
      void useMonitorStore
        .getState()
        .stop(tab.sessionId)
        .catch(() => {})
    }
  }
}))

let wired = false

/** 全局事件桥：session:state / term:exit → store（App 启动时调用一次） */
export function wireSessionEvents(): void {
  if (wired) return
  wired = true

  ofs.on('session:state', ({ sessionId, state, error }) => {
    const { tabs, updateTab } = useSessionStore.getState()
    let claimed = false
    for (const tab of tabs) {
      if (tab.sessionId !== sessionId) continue
      claimed = true
      updateTab(tab.id, { state, error })
      if (state !== 'ready') continue
      // 注意 tab 是本次更新前的快照：everReady 为假即首次连上，不算"恢复"
      if (tab.everReady) {
        // 重新建连 → 让 TerminalPane 重开 shell 并打恢复分隔线（xterm 缓冲保留）
        if (tab.termId === null) updateTab(tab.id, { shellEpoch: tab.shellEpoch + 1 })
      } else {
        updateTab(tab.id, { everReady: true })
      }
    }
    // 还没有 tab 认领这个 sessionId（session:open 尚未 resolve）→ 存下来等认领
    if (!claimed) rememberUnclaimed(sessionId, state, error)
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
