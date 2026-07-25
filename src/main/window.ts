import { BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import { scopedLogger } from './utils/logger'
import { getSettings, patchSettings, settingsStore } from './services/settings'

const log = scopedLogger('window')

/** 与 renderer tokens.css 对应的窗口 chrome 配色 */
const CHROME = {
  dark: { bg: '#16181d', overlayBg: '#1d2026', symbol: '#9aa1ab' },
  light: { bg: '#f5f6f8', overlayBg: '#ffffff', symbol: '#5c636e' }
} as const

export const TITLEBAR_HEIGHT = 40

function resolveMode(settings: AppSettings): 'dark' | 'light' {
  if (settings.themeMode === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return settings.themeMode
}

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 主题变化时同步 titleBarOverlay 配色（Windows） */
export function applyWindowChrome(settings: AppSettings): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const chrome = CHROME[resolveMode(settings)]
  mainWindow.setBackgroundColor(chrome.bg)
  if (process.platform === 'win32') {
    mainWindow.setTitleBarOverlay({
      color: chrome.overlayBg,
      symbolColor: chrome.symbol,
      height: TITLEBAR_HEIGHT
    })
  }
}

export function createMainWindow(): BrowserWindow {
  const settings = getSettings()
  const chrome = CHROME[resolveMode(settings)]

  const win = new BrowserWindow({
    width: settings.window.width,
    height: settings.window.height,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: chrome.bg,
    // titleBarOverlay 而非 frame:false：保留原生窗口按钮，Snap Layouts / 贴边 / 双击最大化免费获得
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: chrome.overlayBg,
      symbolColor: chrome.symbol,
      height: TITLEBAR_HEIGHT
    },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })
  mainWindow = win

  // ---- 安全基线：renderer 是纯视图，任何导航/弹窗/权限请求全拒 ----
  win.webContents.setWindowOpenHandler(({ url }) => {
    log.warn(`blocked window.open: ${url}`)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const allowed = (devUrl && url.startsWith(devUrl)) || url.startsWith('file://')
    if (!allowed) {
      log.warn(`blocked navigation: ${url}`)
      event.preventDefault()
    }
  })
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    // 终端复制/右键粘贴走 navigator.clipboard，需要读写权限；其余全拒
    callback(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read')
  })

  // 崩溃兜底：渲染进程没了 → 记日志并重载
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error(`renderer gone: ${details.reason} (exitCode=${details.exitCode})`)
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) {
      win.webContents.reload()
    }
  })

  win.on('ready-to-show', () => {
    if (settings.window.maximized) win.maximize()
    win.show()
  })

  // 记忆窗口尺寸/最大化状态
  const persistBounds = (): void => {
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const patch: Partial<AppSettings> = { window: { ...getSettings().window, maximized } }
    if (!maximized && !win.isMinimized()) {
      const b = win.getBounds()
      patch.window = { width: b.width, height: b.height, maximized }
    }
    patchSettings(patch)
  }
  win.on('close', persistBounds)
  win.on('closed', () => {
    mainWindow = null
  })

  // 外链兜底：即便有漏网的 target=_blank，也走系统浏览器且仅 http/https
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  // 跟随系统主题时，系统切换 → 更新 chrome 配色
  nativeTheme.on('updated', () => {
    if (getSettings().themeMode === 'system') applyWindowChrome(getSettings())
  })

  void settingsStore // 确保 store 初始化

  return win
}

export { shell }
