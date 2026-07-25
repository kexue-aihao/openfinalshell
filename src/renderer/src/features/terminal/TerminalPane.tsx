import { useCallback, useEffect, useRef } from 'react'
import { App as AntdApp, Button, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { ofs } from '@/ipc/api'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore, type SessionTab } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { createTerminal, type TerminalBundle } from './createTerminal'
import { registerTerm, unregisterTerm } from './termRegistry'
import { resolveTerminalTheme } from '@/themes/terminal'
import styles from './TerminalPane.module.css'

interface Props {
  tab: SessionTab
  active: boolean
  uiMode: 'dark' | 'light'
}

/**
 * 终端面板：一个 tab 一个常驻 xterm 实例。
 * - 会话 ready 后量取 cols/rows 开 shell（term:open）
 * - WebGL 仅在活动 tab 挂载
 * - ResizeObserver + 100ms 防抖 → fit → term:resize（尺寸为 0 时跳过，防 1×1 毁 vim 布局）
 */
export function TerminalPane({ tab, active, uiMode }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { modal } = AntdApp.useApp()
  const settings = useSettingsStore((s) => s.settings)!
  const bindTerm = useSessionStore((s) => s.bindTerm)
  const updateTab = useSessionStore((s) => s.updateTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const openForProfile = useSessionStore((s) => s.openForProfile)

  const mountRef = useRef<HTMLDivElement>(null)
  const bundleRef = useRef<TerminalBundle | null>(null)
  const termIdRef = useRef<string | null>(null)
  const openingRef = useRef(false)

  const sendResize = useCallback((): void => {
    const bundle = bundleRef.current
    const el = mountRef.current
    if (!bundle || !el || el.clientWidth === 0 || el.clientHeight === 0) return
    const before = { cols: bundle.term.cols, rows: bundle.term.rows }
    bundle.fit.fit()
    const { cols, rows } = bundle.term
    if (termIdRef.current && (cols !== before.cols || rows !== before.rows)) {
      void ofs.invoke('term:resize', { termId: termIdRef.current, cols, rows })
    }
  }, [])

  // ---- 创建 xterm 实例（挂载一次，tab 存续期间常驻） ----
  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const bundle = createTerminal(settings, uiMode)
    bundleRef.current = bundle
    bundle.term.open(el)

    // 上行输入
    bundle.term.onData((data) => {
      if (termIdRef.current) ofs.send('term:input', { termId: termIdRef.current, data })
    })

    // 选中即复制
    if (settings.terminal.copyOnSelect) {
      bundle.term.onSelectionChange(() => {
        const sel = bundle.term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {})
      })
    }

    // 快捷键：Ctrl+Shift+C/V；组词中（IME）一律放行
    bundle.term.attachCustomKeyEventHandler((ev) => {
      if (ev.isComposing || ev.keyCode === 229) return true
      if (ev.type !== 'keydown') return true
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
        const sel = bundle.term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {})
        return false
      }
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') {
        void pasteFromClipboard()
        return false
      }
      return true
    })

    // 尺寸自适应
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        raf = requestAnimationFrame(() => sendResize())
      }, 100)
    })
    observer.observe(el)

    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
      cancelAnimationFrame(raf)
      if (termIdRef.current) {
        unregisterTerm(termIdRef.current)
        void ofs.invoke('term:close', termIdRef.current).catch(() => {})
        termIdRef.current = null
      }
      bundle.dispose()
      bundleRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    const text = await navigator.clipboard.readText().catch(() => '')
    if (!text || !termIdRef.current) return
    const doPaste = (): void => {
      if (termIdRef.current) ofs.send('term:input', { termId: termIdRef.current, data: text })
    }
    if (settings.terminal.confirmMultilinePaste && text.includes('\n')) {
      modal.confirm({
        title: t('terminal.multilinePasteTitle'),
        content: t('terminal.multilinePasteContent', { lines: text.split('\n').length }),
        okText: t('common.ok'),
        cancelText: t('common.cancel'),
        onOk: doPaste
      })
    } else {
      doPaste()
    }
  }, [modal, settings.terminal.confirmMultilinePaste, t])

  // 右键 = 粘贴（国内习惯，可在设置切换为菜单）
  const onContextMenu = useCallback(
    (e: React.MouseEvent): void => {
      if (settings.terminal.rightClick === 'paste') {
        e.preventDefault()
        void pasteFromClipboard()
      }
    },
    [pasteFromClipboard, settings.terminal.rightClick]
  )

  // ---- 会话 ready → 开 shell ----
  useEffect(() => {
    const bundle = bundleRef.current
    if (!bundle || tab.state !== 'ready' || tab.termId || !tab.sessionId || openingRef.current) return
    openingRef.current = true
    // 先 fit 得到真实 cols/rows 再开 shell
    sendResize()
    const { cols, rows } = bundle.term
    void ofs
      .invoke('term:open', { sessionId: tab.sessionId, cols, rows })
      .then(({ termId }) => {
        termIdRef.current = termId
        registerTerm(termId, bundle.term)
        bindTerm(tab.id, termId)
        bundle.term.focus()
      })
      .catch((err: Error) => {
        updateTab(tab.id, { state: 'closed', error: err.message })
      })
      .finally(() => {
        openingRef.current = false
      })
  }, [tab.state, tab.termId, tab.sessionId, tab.id, bindTerm, updateTab, sendResize])

  // ---- 激活状态：WebGL 只挂活动 tab；激活后补 fit + focus ----
  useEffect(() => {
    const bundle = bundleRef.current
    if (!bundle) return
    if (active) {
      bundle.attachWebgl()
      sendResize()
      bundle.term.focus()
    } else {
      bundle.detachWebgl()
    }
  }, [active, sendResize])

  // ---- 主题热更新 ----
  useEffect(() => {
    const bundle = bundleRef.current
    if (bundle) {
      bundle.term.options.theme = resolveTerminalTheme(settings.terminal.themeId, uiMode)
    }
  }, [uiMode, settings.terminal.themeId])

  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === tab.profileId))
  const reconnect = (): void => {
    if (!profile) return
    void closeTab(tab.id).then(() => openForProfile(profile))
  }

  const connecting = tab.state === 'connecting' || tab.state === 'authenticating'
  const closed = tab.state === 'closed'

  return (
    <div className={styles.pane} onContextMenu={onContextMenu}>
      <div ref={mountRef} className={styles.mount} />
      {connecting && (
        <div className={styles.overlay}>
          <Spin />
          <div className={styles.overlayText}>
            {t('terminal.connecting', { target: tab.title })}
          </div>
          <Button size="small" onClick={() => void closeTab(tab.id)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
      {closed && (
        <div className={styles.overlay}>
          <div className={`${styles.overlayText} ${tab.error ? styles.overlayError : ''}`}>
            {tab.error ?? t('terminal.disconnected')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="small" type="primary" onClick={reconnect}>
              {t('terminal.reconnect')}
            </Button>
            <Button size="small" onClick={() => void closeTab(tab.id)}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
