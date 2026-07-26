import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import { deepMerge } from '../store/ConfigStore'
import { DocStore } from '../store/DocStore'

let store: DocStore<AppSettings> | null = null

export function settingsStore(): DocStore<AppSettings> {
  if (!store) {
    store = new DocStore<AppSettings>('settings', () => structuredClone(DEFAULT_SETTINGS))
  }
  return store
}

export function getSettings(): AppSettings {
  return settingsStore().data
}

export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = deepMerge(settingsStore().data, patch)
  settingsStore().set(merged)
  return merged
}
