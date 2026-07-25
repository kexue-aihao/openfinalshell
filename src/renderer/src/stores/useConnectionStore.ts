import { create } from 'zustand'
import type { ConnectionGroup, ConnectionProfile, GroupId, ProfileDraft, ProfileId } from '@shared/types'
import { ofs } from '@/ipc/api'

interface ConnectionStore {
  profiles: ConnectionProfile[]
  groups: ConnectionGroup[]
  loaded: boolean
  searchText: string
  load: () => Promise<void>
  save: (draft: ProfileDraft) => Promise<ConnectionProfile>
  remove: (id: ProfileId) => Promise<void>
  duplicate: (id: ProfileId) => Promise<void>
  saveGroup: (group: ConnectionGroup) => Promise<void>
  removeGroup: (id: GroupId) => Promise<void>
  setSearchText: (text: string) => void
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  profiles: [],
  groups: [],
  loaded: false,
  searchText: '',

  load: async () => {
    const { profiles, groups } = await ofs.invoke('conn:list')
    set({ profiles, groups, loaded: true })
  },

  save: async (draft) => {
    const profile = await ofs.invoke('conn:save', draft)
    await get().load()
    return profile
  },

  remove: async (id) => {
    await ofs.invoke('conn:delete', id)
    await get().load()
  },

  duplicate: async (id) => {
    await ofs.invoke('conn:duplicate', id)
    await get().load()
  },

  saveGroup: async (group) => {
    await ofs.invoke('group:save', group)
    await get().load()
  },

  removeGroup: async (id) => {
    await ofs.invoke('group:delete', id)
    await get().load()
  },

  setSearchText: (searchText) => set({ searchText })
}))
