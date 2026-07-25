import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import { JsonFileStore, deepMerge } from '../store/ConfigStore'
import { configFile } from '../store/paths'

let store: JsonFileStore<AppSettings> | null = null

export function settingsStore(): JsonFileStore<AppSettings> {
  if (!store) {
    store = new JsonFileStore<AppSettings>(configFile.settings(), () =>
      structuredClone(DEFAULT_SETTINGS)
    )
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
