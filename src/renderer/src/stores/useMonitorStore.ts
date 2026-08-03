import { create } from 'zustand'
import type { MonitorSnapshot, MonitorState, MonitorStaticInfo, SessionId } from '@shared/types'
import { ofs } from '@/ipc/api'

/** 环形缓冲长度（60 点趋势线） */
export const HISTORY_LEN = 60

export interface MonitorHistory {
  cpu: number[]
  memPct: number[]
  rxBps: number[]
  txBps: number[]
  latencyMs: number[]
}

/**
 * 监控帧不进 React state —— 只有"最新快照"与状态进 store 供数字展示，
 * 趋势数据放模块级 Map 由图表组件直接读取（避免每 2s 重渲染整棵树）。
 */
const histories = new Map<SessionId, MonitorHistory>()

export function historyOf(sessionId: SessionId): MonitorHistory {
  let h = histories.get(sessionId)
  if (!h) {
    h = { cpu: [], memPct: [], rxBps: [], txBps: [], latencyMs: [] }
    histories.set(sessionId, h)
  }
  return h
}

function pushHistory(sessionId: SessionId, snapshot: MonitorSnapshot): void {
  const h = historyOf(sessionId)
  const memPct = snapshot.mem.totalKb > 0 ? (snapshot.mem.usedKb / snapshot.mem.totalKb) * 100 : 0
  const rx = snapshot.net.reduce((sum, n) => sum + n.rxBps, 0)
  const tx = snapshot.net.reduce((sum, n) => sum + n.txBps, 0)
  for (const [arr, value] of [
    [h.cpu, snapshot.cpu.usagePct],
    [h.memPct, Number(memPct.toFixed(1))],
    [h.rxBps, rx],
    [h.txBps, tx],
    // 首帧前 latencyMs 缺失，补 0（图表把 0 画成贴底一格，比空洞好认）
    [h.latencyMs, snapshot.latencyMs ?? 0]
  ] as Array<[number[], number]>) {
    arr.push(value)
    if (arr.length > HISTORY_LEN) arr.shift()
  }
}

interface MonitorStore {
  /** sessionId → 最新快照 */
  latest: Record<SessionId, MonitorSnapshot | undefined>
  staticInfo: Record<SessionId, MonitorStaticInfo | undefined>
  state: Record<SessionId, MonitorState | undefined>
  start: (sessionId: SessionId, intervalMs?: number) => Promise<void>
  stop: (sessionId: SessionId) => Promise<void>
  setInterval: (sessionId: SessionId, intervalMs: number) => Promise<void>
  clear: (sessionId: SessionId) => void
}

export const useMonitorStore = create<MonitorStore>((set) => ({
  latest: {},
  staticInfo: {},
  state: {},

  start: async (sessionId, intervalMs) => {
    set((s) => ({ state: { ...s.state, [sessionId]: 'running' } }))
    try {
      const info = await ofs.invoke('monitor:start', { sessionId, intervalMs })
      if (info) {
        set((s) => ({ staticInfo: { ...s.staticInfo, [sessionId]: info } }))
      }
    } catch (err) {
      set((s) => ({ state: { ...s.state, [sessionId]: 'failed' } }))
      throw err
    }
  },

  stop: async (sessionId) => {
    await ofs.invoke('monitor:stop', sessionId)
    set((s) => ({ state: { ...s.state, [sessionId]: 'stopped' } }))
  },

  setInterval: async (sessionId, intervalMs) => {
    await ofs.invoke('monitor:setInterval', { sessionId, intervalMs })
  },

  clear: (sessionId) => {
    histories.delete(sessionId)
    set((s) => {
      const latest = { ...s.latest }
      const staticInfo = { ...s.staticInfo }
      const state = { ...s.state }
      delete latest[sessionId]
      delete staticInfo[sessionId]
      delete state[sessionId]
      return { latest, staticInfo, state }
    })
  }
}))

let wired = false

export function wireMonitorEvents(): void {
  if (wired) return
  wired = true
  ofs.on('monitor:data', ({ sessionId, snapshot }) => {
    pushHistory(sessionId, snapshot)
    useMonitorStore.setState((s) => {
      // df 与进程列表每 5 tick 才采一次，其余帧为 null/undefined 表示"未变化" ——
      // 沿用上次已知值，否则卡片会每帧闪现一次
      const prev = s.latest[sessionId]
      const merged: MonitorSnapshot = {
        ...snapshot,
        diskFs: snapshot.diskFs ?? prev?.diskFs ?? null,
        topProcs: snapshot.topProcs ?? prev?.topProcs,
        // TCP 状态明细同理每 5 帧才有；不沿用的话明细行会每 5 帧闪一次。
        // conns 反过来每帧都有，不需要沿用（真的是 null 就该显示"没有"）。
        tcpStates: snapshot.tcpStates ?? prev?.tcpStates
      }
      return { latest: { ...s.latest, [sessionId]: merged } }
    })
  })
  ofs.on('monitor:state', ({ sessionId, state }) => {
    useMonitorStore.setState((s) => ({ state: { ...s.state, [sessionId]: state } }))
  })
}
