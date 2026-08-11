import { create } from 'zustand'
import type {
  ImportApplyOptions,
  ImportResult,
  LanSyncDevice,
  LanSyncReceiveState,
  LanSyncSendState
} from '@shared/types'
import { ofs } from '@/ipc/api'

/**
 * 局域网同步的界面状态。**事实全在 main 侧**（它持有监听端口、配对会话、发现应答），
 * 这里是订阅缓存 + 一层薄薄的 invoke 封装，与 useUpdateStore 同款——不做乐观更新，
 * 状态一律等 main 推回来（同步这件事上"界面显示的"必须等于"真发生的"）。
 */
interface LanSyncStore {
  receive: LanSyncReceiveState
  send: LanSyncSendState
  /** 扫描结果（发送卡片列表）；scanning 时先清空 */
  devices: LanSyncDevice[]
  scanning: boolean

  startReceive: () => Promise<void>
  stopReceive: () => Promise<void>
  /** 面板挂载时对齐一次现状——事件可能在挂载前就到过 */
  refreshReceive: () => Promise<void>
  scan: () => Promise<void>
  sendTo: (target: { host: string; port: number }, code: string, includeSecrets: boolean) => Promise<void>
  cancelSend: () => Promise<void>
  apply: (opts: ImportApplyOptions) => Promise<ImportResult>
  dismiss: (token: string) => Promise<void>
}

export const useLanSyncStore = create<LanSyncStore>((set) => ({
  receive: { phase: 'idle' },
  send: { phase: 'idle' },
  devices: [],
  scanning: false,

  startReceive: async () => {
    const receive = await ofs.invoke('sync:receiveStart')
    set({ receive })
  },
  stopReceive: async () => {
    await ofs.invoke('sync:receiveStop')
    // main 会推 idle，但这里也立刻置一次，别让"停止"按钮看着没反应
    set({ receive: { phase: 'idle' } })
  },
  refreshReceive: async () => {
    const receive = await ofs.invoke('sync:receiveStatus')
    set({ receive })
  },
  scan: async () => {
    set({ scanning: true, devices: [] })
    try {
      const devices = await ofs.invoke('sync:scan')
      set({ devices })
    } finally {
      set({ scanning: false })
    }
  },
  sendTo: async (target, code, includeSecrets) => {
    await ofs.invoke('sync:send', { target, code, includeSecrets })
  },
  cancelSend: async () => {
    await ofs.invoke('sync:sendCancel')
    set({ send: { phase: 'idle' } })
  },
  apply: (opts) => ofs.invoke('sync:apply', opts),
  dismiss: (token) => ofs.invoke('sync:dismiss', { token })
}))

let wired = false

/** 订阅 main 推来的收发状态。幂等（模块级守卫），与 wireUpdateEvents 同款 */
export function wireLanSyncEvents(): void {
  if (wired) return
  wired = true
  ofs.on('sync:receiveState', (receive) => useLanSyncStore.setState({ receive }))
  ofs.on('sync:sendState', (send) => useLanSyncStore.setState({ send }))
}
