import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { AppSettings } from '@shared/types'
import { resolveTerminalTheme } from '@/themes/terminal'
import { ofs } from '@/ipc/api'

export interface TerminalBundle {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** 挂/卸 WebGL（仅活动 tab 挂载：Chromium 每页 WebGL context 有 ~16 个上限） */
  attachWebgl: () => void
  detachWebgl: () => void
  dispose: () => void
}

export function createTerminal(settings: AppSettings, uiMode: 'dark' | 'light'): TerminalBundle {
  const t = settings.terminal
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    cursorStyle: t.cursorStyle,
    cursorBlink: t.cursorBlink,
    scrollback: t.scrollback,
    theme: resolveTerminalTheme(t.themeId, uiMode),
    // macOS Option is handled by xterm as a Meta modifier, matching native
    // terminal word-navigation and the app's Option-based tab shortcuts.
    macOptionIsMeta: true
  })

  const fit = new FitAddon()
  const search = new SearchAddon()
  const unicode11 = new Unicode11Addon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(unicode11)
  term.unicode.activeVersion = '11'
  // 终端里的链接是不可信内容：自定义 handler → main 协议白名单 → shell.openExternal
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault()
      void ofs.invoke('app:openExternal', uri).catch(() => {})
    })
  )

  let webgl: WebglAddon | null = null
  const attachWebgl = (): void => {
    if (webgl || !t.webgl) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        addon.dispose()
        webgl = null
      })
      term.loadAddon(addon)
      webgl = addon
    } catch {
      webgl = null // WebGL 不可用 → 回退内置 DOM renderer
    }
  }
  const detachWebgl = (): void => {
    webgl?.dispose()
    webgl = null
  }

  return {
    term,
    fit,
    search,
    attachWebgl,
    detachWebgl,
    dispose: () => {
      detachWebgl()
      term.dispose()
    }
  }
}
