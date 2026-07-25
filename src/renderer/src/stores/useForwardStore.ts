import { create } from 'zustand'
import type { ForwardId, ForwardRule, ForwardRuntime, ProfileId, SessionId } from '@shared/types'
import { ofs } from '@/ipc/api'

export type ForwardRuleWithRuntime = ForwardRule & { runtime?: ForwardRuntime }

interface ForwardStore {
  rules: ForwardRuleWithRuntime[]
  loaded: boolean
  load: (profileId?: ProfileId | null) => Promise<void>
  save: (rule: ForwardRule) => Promise<void>
  remove: (id: ForwardId) => Promise<void>
  start: (id: ForwardId, sessionId: SessionId) => Promise<void>
  stop: (id: ForwardId, sessionId: SessionId) => Promise<void>
}

export const useForwardStore = create<ForwardStore>((set, get) => ({
  rules: [],
  loaded: false,

  load: async (profileId = null) => {
    const rules = await ofs.invoke('forward:list', profileId)
    set({ rules, loaded: true })
  },

  save: async (rule) => {
    await ofs.invoke('forward:save', rule)
    await get().load()
  },

  remove: async (id) => {
    await ofs.invoke('forward:delete', id)
    await get().load()
  },

  start: async (forwardId, sessionId) => {
    await ofs.invoke('forward:control', { forwardId, sessionId, op: 'start' })
  },

  stop: async (forwardId, sessionId) => {
    await ofs.invoke('forward:control', { forwardId, sessionId, op: 'stop' })
  }
}))

let wired = false

export function wireForwardEvents(): void {
  if (wired) return
  wired = true
  ofs.on('forward:state', ({ runtime }) => {
    useForwardStore.setState((s) => ({
      rules: s.rules.map((r) => (r.id === runtime.forwardId ? { ...r, runtime } : r))
    }))
  })
}

/** 规则的人类可读描述 */
export function describeRule(rule: ForwardRule): string {
  if (rule.type === 'dynamic') return `SOCKS5 ${rule.bindAddr}:${rule.bindPort}`
  if (rule.type === 'local') {
    return `${rule.bindAddr}:${rule.bindPort} → ${rule.dstHost}:${rule.dstPort}`
  }
  return `远端 ${rule.bindAddr}:${rule.bindPort} → ${rule.dstHost}:${rule.dstPort}`
}
