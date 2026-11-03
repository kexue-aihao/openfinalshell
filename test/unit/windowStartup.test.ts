import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  overlay: vi.fn((options: { color: string }) => {
    if (options.color === 'transparent') throw new TypeError('Could not parse color as CSS color')
  }),
  load: vi.fn(),
  settings: { themeMode: 'dark', reduceTransparency: false, window: { width: 1200, height: 800, editor: { width: 900, height: 600 } } }
}))

vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), release: () => '10.0.26100' }))
vi.mock('../../src/main/services/settings', () => ({ getSettings: () => calls.settings }))
vi.mock('../../src/main/services/uiEnvironment', () => ({ getUiEnvironment: () => ({ profile: 'windows-11', micaEligible: true }) }))
vi.mock('../../src/main/instances/windowState', () => ({ instanceWindowState: (value: unknown) => value, saveInstanceWindowState: vi.fn() }))
vi.mock('../../src/main/ipc/registry', () => ({
  bindMainWindowForInstance: (instance: { mainWindow: unknown }, win: unknown) => { instance.mainWindow = win },
  bindEditorWindow: vi.fn(), emitEditor: vi.fn()
}))
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
      isMinimized = () => false
      focus = vi.fn()
      close = () => this.emit('closed')
      loadFile = calls.load
    }
  }
})

import { createMainWindow, applyWindowChrome } from '../../src/main/window'
import { currentInstance } from '../../src/main/instance'
import { openInEditorWindow, applyEditorWindowChrome, flushEditorQueue, confirmCloseEditorWindow } from '../../src/main/editorWindow'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' }))
afterAll(() => { Object.defineProperty(process, 'platform', originalPlatform); currentInstance.mainWindow = null })
beforeEach(() => { calls.overlay.mockClear(); calls.load.mockClear() })

describe('Windows caption color compatibility', () => {
  it('opens the application and applies theme changes when Electron rejects a transparent caption', () => {
    const win = createMainWindow()
    expect(calls.overlay.mock.calls.map(([options]) => options.color)).toEqual(['transparent', '#202020'])
    expect(calls.load).toHaveBeenCalledOnce()
    calls.overlay.mockClear()
    applyWindowChrome({ ...calls.settings, themeMode: 'light' } as Parameters<typeof applyWindowChrome>[0])
    expect(calls.overlay.mock.calls.map(([options]) => options.color)).toEqual(['transparent', '#f3f3f3'])
    win.emit('closed')
  })

  it('delivers editor files and switches themes even when the native caption parser rejects transparency', () => {
    const request = { sessionId: 'session', path: '/demo.conf', origin: 'test' }
    try {
      expect(() => openInEditorWindow(request)).not.toThrow()
      expect(calls.overlay.mock.calls.map(([options]) => options.color)).toEqual(['transparent', '#202020'])
      expect(calls.load).toHaveBeenCalledOnce()
      expect(flushEditorQueue()).toEqual([request])
      calls.overlay.mockClear()
      expect(() => applyEditorWindowChrome({ ...calls.settings, themeMode: 'light' } as Parameters<typeof applyEditorWindowChrome>[0])).not.toThrow()
      expect(calls.overlay.mock.calls.map(([options]) => options.color)).toEqual(['transparent', '#f3f3f3'])
    } finally {
      confirmCloseEditorWindow()
    }
  })
})
