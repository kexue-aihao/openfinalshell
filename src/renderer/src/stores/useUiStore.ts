import { create } from 'zustand'
import type { ProfileId, TermId } from '@shared/types'
import { useSessionStore } from './useSessionStore'

function activeSshTermId(): TermId | undefined {
  const { tabs, activeTabId } = useSessionStore.getState()
  const tab = tabs.find((item) => item.id === activeTabId)
  return tab && (!tab.kind || tab.kind === 'terminal') && tab.state === 'ready' ? tab.termId ?? undefined : undefined
}

/** 瞬态 UI 状态，不持久化 */
interface UiStore {
  settingsOpen: boolean
  aiOpen: boolean
  aiPrefill: string
  aiTargetTermId?: TermId
  settingsSection?: string
  /** null=关闭；'new'=新建；其余为编辑的 profileId */
  editingProfileId: ProfileId | 'new' | null
  transferDrawerOpen: boolean
  setSettingsOpen: (open: boolean) => void
  openSettingsSection: (section: string) => void
  setAiOpen: (open: boolean, termId?: TermId) => void
  setAiTargetTermId: (termId?: TermId) => void
  openAiWithText: (text: string, termId?: TermId) => void
  setEditingProfile: (id: ProfileId | 'new' | null) => void
  setTransferDrawerOpen: (open: boolean) => void
}

export const useUiStore = create<UiStore>((set) => ({
  settingsOpen: false,
  aiOpen: false,
  aiPrefill: '',
  aiTargetTermId: undefined,
  settingsSection: undefined,
  editingProfileId: null,
  transferDrawerOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openSettingsSection: (settingsSection) => set({ settingsOpen: true, settingsSection }),
  setAiOpen: (aiOpen, termId) => set({ aiOpen, aiTargetTermId: aiOpen ? termId ?? activeSshTermId() : undefined }),
  setAiTargetTermId: (aiTargetTermId) => set({ aiTargetTermId }),
  openAiWithText: (aiPrefill, termId) => set({ aiOpen: true, aiPrefill, aiTargetTermId: termId ?? activeSshTermId() }),
  setEditingProfile: (editingProfileId) => set({ editingProfileId }),
  setTransferDrawerOpen: (transferDrawerOpen) => set({ transferDrawerOpen })
}))
