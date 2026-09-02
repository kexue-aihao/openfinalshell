import { BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import type { AppSettings, EditorOpenRequest } from '@shared/types'
import { scopedLogger } from './utils/logger'
import { getSettings, patchSettings } from './services/settings'
import { applyNativeWindowMaterial, resolveChrome, TITLEBAR_HEIGHT } from './window'
import { resolveWindowControlsOverlayColor } from './windowMaterial'
import { bindEditorWindow, emitEditor } from './ipc/registry'

const log = scopedLogger('editorWindow')

/**
 * 独立编辑器窗口：**单例**。所有会话的「内置编辑器查看」都汇到这一个窗口里做多标签。
 *
 * 生命周期上的两个要点：
 *
 * 1. **打开请求要排队。** 窗口刚创建时 renderer 还没订阅 editor:open，直接
 *    webContents.send 必丢（发进虚空，一个错都不报）。所以 renderer 就绪前的请求
 *    全进 pending，renderer 订阅完成后 invoke editor:ready 一次性取走，之后转直发。
 *
 * 2. **关闭要过 renderer 的手。** 窗口里可能有没保存的改动，而只有 renderer 知道 ——
 *    close 一律 preventDefault 再发 editor:closeRequest，renderer 裁决完（无脏直接放行、
 *    有脏弹确认）invoke editor:closeNow 才真正关。renderer 没就绪（或崩了）时不拦：
 *    那种状态下不可能有未保存的输入，拦了反而把窗口锁死。
 */
let win: BrowserWindow | null = null
let rendererReady = false
let allowClose = false
let pending: EditorOpenRequest[] = []

/** 主题热切换时同步编辑器窗口的 chrome（与主窗口的 applyWindowChrome 并排调用） */
export function applyEditorWindowChrome(settings: AppSettings): void {
  if (!win || win.isDestroyed()) return
  const chrome = resolveChrome(settings)
  win.setBackgroundColor(chrome.bg)
  const material = applyNativeWindowMaterial(win, settings)
  if (process.platform === 'win32') {
    win.setTitleBarOverlay({
      color: resolveWindowControlsOverlayColor(material, chrome.overlayBg),
      symbolColor: chrome.symbol,
      height: TITLEBAR_HEIGHT
    })
  }
}

// 跟随系统主题：模块级挂一次，win 为空时是 no-op（主窗口那份在 window.ts，互不 import）
nativeTheme.on('updated', () => {
  if (getSettings().themeMode === 'system') applyEditorWindowChrome(getSettings())
})

function createWindow(): BrowserWindow {
  const settings = getSettings()
  const chrome = resolveChrome(settings)
  const bounds = settings.window.editor

  const w = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 640,
    minHeight: 420,
    show: false,
    backgroundColor: chrome.bg,
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
  const material = applyNativeWindowMaterial(w, settings)
  if (process.platform === 'win32') {
    w.setTitleBarOverlay({
      color: resolveWindowControlsOverlayColor(material, chrome.overlayBg),
      symbolColor: chrome.symbol,
      height: TITLEBAR_HEIGHT
    })
  }

  // ---- 安全基线与主窗口逐条对齐（见 window.ts）----
  w.webContents.setWindowOpenHandler(({ url }) => {
    log.warn(`blocked window.open: ${url}`)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const allowed = (devUrl && url.startsWith(devUrl)) || url.startsWith('file://')
    if (!allowed) {
      log.warn(`blocked navigation: ${url}`)
      event.preventDefault()
    }
  })
  w.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read')
  })
  w.webContents.on('will-attach-webview', (e) => e.preventDefault())
  w.webContents.on('render-process-gone', (_event, details) => {
    log.error(`editor renderer gone: ${details.reason} (exitCode=${details.exitCode})`)
    // renderer 没了 = 未保存的输入已经没了，关闭裁决没有对象；放行 close，重载可自愈
    rendererReady = false
    if (details.reason !== 'clean-exit' && !w.isDestroyed()) {
      w.webContents.reload()
    }
  })

  w.on('ready-to-show', () => {
    if (getSettings().window.editor.maximized) w.maximize()
    w.show()
  })

  // 记忆窗口尺寸（与主窗口 persistBounds 同款，写进 window.editor 这一档）
  w.on('close', (e) => {
    if (!w.isDestroyed()) {
      const maximized = w.isMaximized()
      const cur = getSettings().window
      let editor = { ...cur.editor, maximized }
      if (!maximized && !w.isMinimized()) {
        const b = w.getBounds()
        editor = { width: b.width, height: b.height, maximized }
      }
      patchSettings({ window: { ...cur, editor } })
    }
    /*
     * 关闭裁决：renderer 就绪时一律拦下来交给它（只有它知道有没有脏文件）。
     * allowClose 由 editor:closeNow 置真 —— 那条 invoke 是"裁决完毕"的唯一信号。
     */
    if (allowClose || !rendererReady) return
    e.preventDefault()
    emitEditor('editor:closeRequest', null)
  })

  w.on('closed', () => {
    win = null
    rendererReady = false
    allowClose = false
    pending = []
    bindEditorWindow(null)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/editor`)
  } else {
    void w.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: '/editor' })
  }

  return w
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = createWindow()
  bindEditorWindow(win)
  return win
}

/** 主窗口点了「内置编辑器查看」：确保窗口在、把请求送达（或排队）、把窗口拉到前面 */
export function openInEditorWindow(req: EditorOpenRequest): void {
  const w = ensureWindow()
  if (rendererReady) {
    emitEditor('editor:open', req)
  } else {
    pending.push(req)
  }
  if (w.isMinimized()) w.restore()
  w.focus()
}

/** renderer 订阅完成（invoke editor:ready）：取走排队的请求，此后转直发 */
export function flushEditorQueue(): EditorOpenRequest[] {
  rendererReady = true
  const queued = pending
  pending = []
  return queued
}

/** renderer 裁决完毕（invoke editor:closeNow）：放行这一次关闭 */
export function confirmCloseEditorWindow(): void {
  if (!win || win.isDestroyed()) return
  allowClose = true
  win.close()
}

/**
 * 主窗口关闭时把编辑器窗口也带走 —— 但走**同一条**裁决链路，不是硬杀：
 * 有脏文件时编辑器窗口会问一句，用户取消则两个都留着（应用等它收尾才退出）。
 */
export function closeEditorWindowIfOpen(): void {
  if (win && !win.isDestroyed()) win.close()
}
