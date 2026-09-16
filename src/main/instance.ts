import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'

export interface InstanceContext {
  readonly instanceId: string
  readonly isExplicitNewInstance: boolean
  mainWindow: BrowserWindow | null
  editorWindow: BrowserWindow | null
  closing: boolean
  readonly resources: Map<string, unknown>
}

export function createInstanceContext(isExplicitNewInstance: boolean): InstanceContext {
  return { instanceId: randomUUID(), isExplicitNewInstance, mainWindow: null, editorWindow: null, closing: false, resources: new Map() }
}

/** One process owns exactly one full application instance. Never share this object over IPC. */
export const currentInstance = createInstanceContext(process.argv.includes('--new-instance'))

export function instanceResource<T>(name: string, create: () => T): T {
  if (!currentInstance.resources.has(name)) currentInstance.resources.set(name, create())
  return currentInstance.resources.get(name) as T
}
