import { create } from 'zustand'
import type { UpdateActivity, UpdateState } from '@shared/types'
import { ofs } from '@/ipc/api'

/**
 * 更新器状态。**事实全在 main 侧**（它才持有 autoUpdater），这里是一份订阅缓存。
 *
 * 没有"下载"按钮对应的乐观更新：状态一律等 main 推回来 ——
 * 更新这件事上"界面显示的与实际发生的"不一致，比慢半秒糟得多。
 */
interface UpdateStore {
  state: UpdateState | null
  /** 安装前那份"会断掉什么"的清单；非 null 时界面弹确认框 */
  confirm: UpdateActivity | null
  check: () => Promise<void>
  /** 返回 true 表示真的开始装了（应用马上要退出） */
  install: (force: boolean) => Promise<boolean>
  dismissConfirm: () => void
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  state: null,
  confirm: null,

  check: async () => {
    const state = await ofs.invoke('update:check')
    set({ state })
  },

  install: async (force) => {
    const r = await ofs.invoke('update:install', { force })
    if ('needsConfirm' in r) {
      set({ confirm: r.needsConfirm })
      return false
    }
    if ('error' in r) {
      set((s) => ({ state: s.state ? { ...s.state, status: 'error', error: r.error } : s.state }))
      return false
    }
    return true
  },

  dismissConfirm: () => set({ confirm: null })
}))

let wired = false

/** 订阅 main 推来的状态。幂等（模块级守卫），与 wireForwardEvents 同款 */
export function wireUpdateEvents(): void {
  if (wired) return
  wired = true
  ofs.on('update:state', (state) => useUpdateStore.setState({ state }))
}
