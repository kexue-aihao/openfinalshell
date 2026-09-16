import type { AppSettings } from '@shared/types'
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { currentInstance } from '../instance'

const boundsSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive(), maximized: z.boolean() })
const stateSchema = boundsSchema.extend({ editor: boundsSchema })

/** Explicit siblings never change the default window's next-launch layout. */
export function instanceWindowState(fallback: AppSettings['window']): AppSettings['window'] {
  const value = currentInstance.resources.get('windowBounds') as AppSettings['window'] | undefined
  if (value) return value
  let initial = structuredClone(fallback)
  if (!currentInstance.isExplicitNewInstance) {
    try { initial = stateSchema.parse(JSON.parse(readFileSync(join(app.getPath('userData'), 'instances', 'default-window-state.json'), 'utf8'))) } catch { /* first run or invalid preference */ }
  }
  currentInstance.resources.set('windowBounds', initial)
  return initial
}

export function saveInstanceWindowState(value: AppSettings['window']): void {
  currentInstance.resources.set('windowBounds', structuredClone(value))
  // A process never restores another UUID's window state or overwrites shared preferences.
  const directory = join(app.getPath('userData'), 'instances', currentInstance.instanceId)
  try {
    mkdirSync(directory, { recursive: true })
    const temporary = join(directory, 'window-state.json.tmp')
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
    renameSync(temporary, join(directory, 'window-state.json'))
    if (!currentInstance.isExplicitNewInstance) {
      const defaultFile = join(directory, '..', 'default-window-state.json')
      writeFileSync(`${defaultFile}.tmp`, JSON.stringify(value), { mode: 0o600 })
      renameSync(`${defaultFile}.tmp`, defaultFile)
    }
  } catch { /* A display preference must not block session cleanup. */ }
}
