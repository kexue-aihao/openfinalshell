import { z } from 'zod'
import { safeStorage } from 'electron'
import { emit, handle } from './registry'
import { getSettings, patchSettings } from '../services/settings'
import { applyWindowChrome } from '../window'

export function registerSettingsIpc(): void {
  handle('settings:get', () => getSettings())

  handle(
    'settings:set',
    (patch) => {
      const next = patchSettings(patch)
      applyWindowChrome(next)
      emit('settings:changed', next)
      return next
    },
    z.tuple([z.record(z.string(), z.unknown())])
  )

  handle('vault:isAvailable', () => safeStorage.isEncryptionAvailable())
}
