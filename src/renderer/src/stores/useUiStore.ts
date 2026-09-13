import { create } from 'zustand'
import type { ProfileId, TermId } from '@shared/types'

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
  setAiOpen: (open: boolean) => void
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
  setAiOpen: (aiOpen) => set(aiOpen ? { aiOpen } : { aiOpen, aiTargetTermId: undefined }),
  openAiWithText: (aiPrefill, aiTargetTermId) => set({ aiOpen: true, aiPrefill, aiTargetTermId }),
  setEditingProfile: (editingProfileId) => set({ editingProfileId }),
  setTransferDrawerOpen: (transferDrawerOpen) => set({ transferDrawerOpen })
}))
