import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  overlay: vi.fn((options: { color: string }) => {
    if (options.color === 'transparent') throw new TypeError('Could not parse color as CSS color')
  }),
  load: vi.fn(),
  settings: { themeMode: 'dark', reduceTransparency: false, window: { width: 1200, height: 800 } }
}))

vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), release: () => '10.0.26100' }))
vi.mock('../../src/main/services/settings', () => ({ getSettings: () => calls.settings }))
vi.mock('../../src/main/instances/windowState', () => ({ instanceWindowState: (value: unknown) => value, saveInstanceWindowState: vi.fn() }))
vi.mock('../../src/main/ipc/registry', () => ({ bindMainWindowForInstance: (instance: { mainWindow: unknown }, win: unknown) => { instance.mainWindow = win } }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true }),
    shell: {},
    BrowserWindow: class extends EventEmitter {
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn() }
      })
      setBackgroundMaterial = vi.fn()
      setTitleBarOverlay = calls.overlay
      setBackgroundColor = vi.fn()
      isDestroyed = () => false
      loadFile = calls.load
    }
  }
})

import { createMainWindow, applyWindowChrome } from '../../src/main/window'
import { currentInstance } from '../../src/main/instance'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' }))
afterAll(() => { Object.defineProperty(process, 'platform', originalPlatform); currentInstance.mainWindow = null })

describe('Windows caption color compatibility', () => {
  it('opens the application and applies theme changes when Electron rejects a transparent caption', () => {
    const win = createMainWindow()
    expect(calls.overlay.mock.calls.map(([options]) => options.color)).toEqual(['transparent', '#1d2026'])
    expect(calls.load).toHaveBeenCalledOnce()
    calls.overlay.mockClear()
    applyWindowChrome({ ...calls.settings, themeMode: 'light' } as Parameters<typeof applyWindowChrome>[0])
    expect(calls.overlay.mock.calls.map(([options]) => options.color)).toEqual(['transparent', '#ffffff'])
    win.emit('closed')
  })
})
