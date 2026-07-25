import { create } from 'zustand'
import type { ProfileId } from '@shared/types'

/** 瞬态 UI 状态，不持久化 */
interface UiStore {
  settingsOpen: boolean
  /** null=关闭；'new'=新建；其余为编辑的 profileId */
  editingProfileId: ProfileId | 'new' | null
  transferDrawerOpen: boolean
  setSettingsOpen: (open: boolean) => void
  setEditingProfile: (id: ProfileId | 'new' | null) => void
  setTransferDrawerOpen: (open: boolean) => void
}

export const useUiStore = create<UiStore>((set) => ({
  settingsOpen: false,
  editingProfileId: null,
  transferDrawerOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setEditingProfile: (editingProfileId) => set({ editingProfileId }),
  setTransferDrawerOpen: (transferDrawerOpen) => set({ transferDrawerOpen })
}))
