import { create } from 'zustand'
import type {
  DeleteRefResult,
  SavedPrivateKey,
  SavedPrivateKeyDraft,
  SavedProxy,
  SavedProxyDraft
} from '@shared/types'
import { ofs } from '@/ipc/api'

/**
 * 「已保存的代理」与「已保存的私钥」。
 *
 * 两类放同一个 store，因为它们**总是一起被用到**：连接编辑抽屉里两个下拉框、
 * 设置页里同一个区段。分成两个 store 会让那两处各写一遍 `if (!loaded) load()`。
 *
 * 写完**全量重载**（照 `useConnectionStore` 的做法），不做乐观更新 ——
 * 全项目只有 `useHistoryStore` 是乐观的，而它那么做的理由（浮层要立刻看到刚敲的命令）
 * 在这里不成立：这两类实体的编辑是低频的、有明确的保存按钮。
 */
interface SavedRefStore {
  proxies: SavedProxy[]
  keys: SavedPrivateKey[]
  loaded: boolean
  load: () => Promise<void>
  saveProxy: (draft: SavedProxyDraft) => Promise<SavedProxy>
  removeProxy: (id: string) => Promise<DeleteRefResult>
  saveKey: (draft: SavedPrivateKeyDraft) => Promise<SavedPrivateKey>
  removeKey: (id: string) => Promise<DeleteRefResult>
}

export const useSavedRefStore = create<SavedRefStore>((set, get) => ({
  proxies: [],
  keys: [],
  loaded: false,

  load: async () => {
    const [proxies, keys] = await Promise.all([
      ofs.invoke('proxy:list'),
      ofs.invoke('key:list')
    ])
    set({ proxies, keys, loaded: true })
  },

  saveProxy: async (draft) => {
    const saved = await ofs.invoke('proxy:save', draft)
    await get().load()
    return saved
  },

  removeProxy: async (id) => {
    const r = await ofs.invoke('proxy:delete', id)
    // 被引用时没删成，但重载一次也无害（而且能把别处的改动带回来）
    await get().load()
    return r
  },

  saveKey: async (draft) => {
    const saved = await ofs.invoke('key:save', draft)
    await get().load()
    return saved
  },

  removeKey: async (id) => {
    const r = await ofs.invoke('key:delete', id)
    await get().load()
    return r
  }
}))
