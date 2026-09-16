import { create } from 'zustand'
import type { AppSettings } from '@shared/types'
import { ofs } from '@/ipc/api'

interface SettingsStore {
  settings: AppSettings | null
  /** 启动时加载一次并订阅 main 侧变更 */
  init: () => Promise<void>
  /** 局部更新：乐观合并本地 + 持久化到 main */
  patch: (patch: Partial<AppSettings>) => void
}

function deepMergeLocal<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (
    base === null ||
    patch === null ||
    typeof base !== 'object' ||
    typeof patch !== 'object' ||
    Array.isArray(base) ||
    Array.isArray(patch)
  ) {
    return patch as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMergeLocal((base as Record<string, unknown>)[k], v)
  }
  return out as T
}

let initialized = false

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,

  init: async () => {
    if (initialized) return
    initialized = true
    const settings = await ofs.invoke('settings:get')
    set({ settings })
    ofs.on('settings:changed', (next) => set({ settings: next }))
  },

  patch: (patch) => {
    const current = get().settings
    if (!current) return
    set({ settings: deepMergeLocal(current, patch) })
    void ofs.invoke('settings:set', patch, current).then((settings) => set({ settings })).catch(async () => {
      // A stale optimistic write must not leave the UI claiming the save succeeded.
      const settings = await ofs.invoke('settings:get')
      set({ settings })
      window.dispatchEvent(new CustomEvent('ofs:configConflict', { detail: '设置保存失败或已被其他窗口修改，已重新加载。' }))
    })
  }
}))
