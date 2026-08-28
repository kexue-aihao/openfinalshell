import { create } from 'zustand'
import type { PortTrafficSnapshot, PortTrafficState, SessionId } from '@shared/types'
import { ofs } from '@/ipc/api'

interface PortTrafficStore {
  latest: Record<SessionId, PortTrafficSnapshot | undefined>
  state: Record<SessionId, PortTrafficState | undefined>
  error: Record<SessionId, string | undefined>
  start: (sessionId: SessionId) => Promise<void>
  stop: (sessionId: SessionId) => Promise<void>
  clear: (sessionId: SessionId) => void
}

/** 端口流量快照只在对应的工具标签打开期间存在，不与右侧监控的历史混用。 */
export const usePortTrafficStore = create<PortTrafficStore>((set) => ({
  latest: {},
  state: {},
  error: {},

  start: async (sessionId) => {
    await ofs.invoke('portTraffic:start', sessionId)
  },

  stop: async (sessionId) => {
    await ofs.invoke('portTraffic:stop', sessionId)
  },

  clear: (sessionId) =>
    set((s) => {
      const latest = { ...s.latest }
      const state = { ...s.state }
      const error = { ...s.error }
      delete latest[sessionId]
      delete state[sessionId]
      delete error[sessionId]
      return { latest, state, error }
    })
}))

let wired = false

export function wirePortTrafficEvents(): void {
  if (wired) return
  wired = true
  ofs.on('portTraffic:data', ({ sessionId, snapshot }) => {
    usePortTrafficStore.setState((s) => ({
      latest: { ...s.latest, [sessionId]: snapshot },
      state: { ...s.state, [sessionId]: 'running' },
      error: { ...s.error, [sessionId]: undefined }
    }))
  })
  ofs.on('portTraffic:state', ({ sessionId, state, error }) => {
    usePortTrafficStore.setState((s) => ({
      state: { ...s.state, [sessionId]: state },
      error: { ...s.error, [sessionId]: error }
    }))
  })
}
