import { randomUUID } from 'node:crypto'
import type { ForwardId, ForwardRule, ProfileId } from '@shared/types'
import { JsonFileStore } from './ConfigStore'
import { configDir } from './paths'
import { join } from 'node:path'

interface ForwardsFile {
  version: number
  rules: ForwardRule[]
}

let store: JsonFileStore<ForwardsFile> | null = null

function forwardStore(): JsonFileStore<ForwardsFile> {
  if (!store) {
    store = new JsonFileStore<ForwardsFile>(join(configDir(), 'forwards.json'), () => ({
      version: 1,
      rules: []
    }))
  }
  return store
}

export function listForwards(profileId: ProfileId | null): ForwardRule[] {
  const rules = forwardStore().data.rules
  return profileId === null ? rules : rules.filter((r) => r.profileId === profileId)
}

export function getForward(id: ForwardId): ForwardRule | undefined {
  return forwardStore().data.rules.find((r) => r.id === id)
}

export function saveForward(rule: ForwardRule): ForwardRule {
  const saved: ForwardRule = { ...rule, id: rule.id || randomUUID() }
  forwardStore().update((d) => {
    const idx = d.rules.findIndex((r) => r.id === saved.id)
    if (idx >= 0) d.rules[idx] = saved
    else d.rules.push(saved)
  })
  return saved
}

export function deleteForward(id: ForwardId): void {
  forwardStore().update((d) => {
    d.rules = d.rules.filter((r) => r.id !== id)
  })
}

/** 连接建立后自动启动的规则 */
export function autoStartRules(profileId: ProfileId): ForwardRule[] {
  return listForwards(profileId).filter((r) => r.autoStart)
}

export async function flushForwards(): Promise<void> {
  await forwardStore().flush()
}
