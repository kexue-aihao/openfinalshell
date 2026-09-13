import { create } from 'zustand'
import type { ProfileId } from '@shared/types'

/** 瞬态 UI 状态，不持久化 */
interface UiStore {
  settingsOpen: boolean
  aiOpen: boolean
  aiPrefill: string
  /** null=关闭；'new'=新建；其余为编辑的 profileId */
  editingProfileId: ProfileId | 'new' | null
  transferDrawerOpen: boolean
  setSettingsOpen: (open: boolean) => void
  setAiOpen: (open: boolean) => void
  openAiWithText: (text: string) => void
  setEditingProfile: (id: ProfileId | 'new' | null) => void
  setTransferDrawerOpen: (open: boolean) => void
}

export const useUiStore = create<UiStore>((set) => ({
  settingsOpen: false,
  aiOpen: false,
  aiPrefill: '',
  editingProfileId: null,
  transferDrawerOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setAiOpen: (aiOpen) => set({ aiOpen }),
  openAiWithText: (aiPrefill) => set({ aiOpen: true, aiPrefill }),
  setEditingProfile: (editingProfileId) => set({ editingProfileId }),
  setTransferDrawerOpen: (transferDrawerOpen) => set({ transferDrawerOpen })
}))
