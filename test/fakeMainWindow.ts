import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { bindMainWindow as bind } from '../src/main/ipc/registry'

let nextId = 1
/** Existing service tests only supplied send(); registration now needs a real window lifecycle/id. */
export function bindMainWindow(window: BrowserWindow): void {
  const events = new EventEmitter()
  bind({ ...window, once: events.once.bind(events), webContents: { ...window.webContents, id: nextId++ } } as unknown as BrowserWindow)
}
