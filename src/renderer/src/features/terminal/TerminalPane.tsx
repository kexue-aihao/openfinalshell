import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Dropdown, Spin } from 'antd'
import { Activity, Eraser, FolderTree, Search, Unplug } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ofs } from '@/ipc/api'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore, type SessionTab } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { TitlebarSafeTooltip } from '@/components/TitlebarSafeTooltip'
import { createTerminal, type TerminalBundle } from './createTerminal'
import { registerTerm, unregisterTerm } from './termRegistry'
import { SearchOverlay } from './SearchOverlay'
import { resolveTerminalTheme } from '@/themes/terminal'
import styles from './TerminalPane.module.css'

interface Props {
  tab: SessionTab
  active: boolean
  uiMode: 'dark' | 'light'
}

/**
 * 终端面板：一个 tab 一个常驻 xterm 实例（重连时复用，缓冲不丢）。
 * - 会话 ready（或 shellEpoch 递增）后量取 cols/rows 开 shell
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
  const reconnectTab = useSessionStore((s) => s.reconnectTab)
  const toggleSftp = useSessionStore((s) => s.toggleSftp)
  const toggleMonitor = useSessionStore((s) => s.toggleMonitor)
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === tab.profileId))

  const mountRef = useRef<HTMLDivElement>(null)
  const bundleRef = useRef<TerminalBundle | null>(null)
  const termIdRef = useRef<string | null>(null)
  const openingRef = useRef(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)

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

  // ---- 创建 xterm 实例（tab 存续期间常驻，重连不重建） ----
  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const bundle = createTerminal(settings, uiMode)
    bundleRef.current = bundle
    bundle.term.open(el)

    bundle.term.onData((data) => {
      if (termIdRef.current) ofs.send('term:input', { termId: termIdRef.current, data })
    })

    if (settings.terminal.copyOnSelect) {
      bundle.term.onSelectionChange(() => {
        const sel = bundle.term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {})
      })
    }

    // 组词中（IME）一律放行，避免候选上屏时误触快捷键
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
      if (ev.ctrlKey && !ev.shiftKey && ev.code === 'KeyF') {
        setSearchOpen(true)
        return false
      }
      return true
    })

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

  const onContextMenu = useCallback(
    (e: React.MouseEvent): void => {
      if (settings.terminal.rightClick === 'paste') {
        e.preventDefault()
        void pasteFromClipboard()
      }
    },
    [pasteFromClipboard, settings.terminal.rightClick]
  )

  // ---- 会话 ready / 重连（shellEpoch 变化）→ 开 shell ----
  useEffect(() => {
    const bundle = bundleRef.current
    if (!bundle || tab.state !== 'ready' || tab.termId || !tab.sessionId || openingRef.current) return
    openingRef.current = true
    sendResize()
    const { cols, rows } = bundle.term
    void ofs
      .invoke('term:open', { sessionId: tab.sessionId, cols, rows })
      .then(({ termId }) => {
        termIdRef.current = termId
        registerTerm(termId, bundle.term)
        bindTerm(tab.id, termId)
        if (tab.shellEpoch > 0) {
          bundle.term.write('\r\n\x1b[2m—— 连接已恢复 ——\x1b[0m\r\n')
        }
        if (active) bundle.term.focus()
      })
      .catch((err: Error) => {
        updateTab(tab.id, { state: 'closed', error: err.message })
      })
      .finally(() => {
        openingRef.current = false
      })
  }, [
    tab.state,
    tab.termId,
    tab.sessionId,
    tab.shellEpoch,
    tab.id,
    active,
    bindTerm,
    updateTab,
    sendResize
  ])

  // ---- WebGL 只挂活动 tab；激活后补 fit + focus ----
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

  const connecting = tab.state === 'connecting' || tab.state === 'authenticating'
  const reconnecting = tab.state === 'reconnecting'
  const closed = tab.state === 'closed'

  const menuItems =
    settings.terminal.rightClick === 'menu'
      ? [
          { key: 'copy', label: t('terminal.copy') },
          { key: 'paste', label: t('terminal.paste') },
          { key: 'selectAll', label: t('terminal.selectAll') },
          { type: 'divider' as const },
          { key: 'clear', label: t('terminal.clear') },
          { key: 'search', label: t('terminal.search') },
          { type: 'divider' as const },
          { key: 'disconnect', label: t('terminal.disconnect'), danger: true }
        ]
      : []

  const onMenuClick = (key: string): void => {
    const bundle = bundleRef.current
    if (!bundle) return
    if (key === 'copy') {
      const sel = bundle.term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel).catch(() => {})
    } else if (key === 'paste') void pasteFromClipboard()
    else if (key === 'selectAll') bundle.term.selectAll()
    else if (key === 'clear') bundle.term.clear()
    else if (key === 'search') setSearchOpen(true)
    else if (key === 'disconnect') void closeTab(tab.id)
  }

  const paneBody = (
    <div className={styles.pane} onContextMenu={onContextMenu}>
      <div ref={mountRef} className={styles.mount} />

      {active && !connecting && !closed && (
        <div className={styles.hoverTools}>
          <TitlebarSafeTooltip title={tab.sftpOpen ? t('terminal.closeSftp') : t('terminal.openSftp')}>
            <Button
              size="small"
              type={tab.sftpOpen ? 'primary' : 'text'}
              icon={<FolderTree size={14} strokeWidth={1.75} />}
              onClick={() => toggleSftp(tab.id)}
            />
          </TitlebarSafeTooltip>
          <TitlebarSafeTooltip title={tab.monitorOpen ? t('terminal.closeMonitor') : t('terminal.openMonitor')}>
            <Button
              size="small"
              type={tab.monitorOpen ? 'primary' : 'text'}
              icon={<Activity size={14} strokeWidth={1.75} />}
              onClick={() => toggleMonitor(tab.id)}
            />
          </TitlebarSafeTooltip>
          <TitlebarSafeTooltip title={t('terminal.search')}>
            <Button
              size="small"
              type="text"
              icon={<Search size={14} strokeWidth={1.75} />}
              onClick={() => setSearchOpen(true)}
            />
          </TitlebarSafeTooltip>
          <TitlebarSafeTooltip title={t('terminal.clear')}>
            <Button
              size="small"
              type="text"
              icon={<Eraser size={14} strokeWidth={1.75} />}
              onClick={() => bundleRef.current?.term.clear()}
            />
          </TitlebarSafeTooltip>
          <TitlebarSafeTooltip title={t('terminal.disconnect')}>
            <Button
              size="small"
              type="text"
              danger
              icon={<Unplug size={14} strokeWidth={1.75} />}
              onClick={() => void closeTab(tab.id)}
            />
          </TitlebarSafeTooltip>
        </div>
      )}

      {searchOpen && bundleRef.current && (
        <SearchOverlay
          search={bundleRef.current.search}
          accent={settings.accent}
          onClose={() => {
            setSearchOpen(false)
            bundleRef.current?.term.focus()
          }}
        />
      )}

      {connecting && (
        <div className={styles.overlay}>
          <Spin />
          <div className={styles.overlayText}>{t('terminal.connecting', { target: tab.title })}</div>
          <Button size="small" onClick={() => void closeTab(tab.id)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}

      {reconnecting && (
        <div className={styles.overlay}>
          <Spin />
          <div className={`${styles.overlayText} ${styles.overlayWarning}`}>
            {tab.error ?? t('terminal.reconnecting')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="small" type="primary" onClick={() => void reconnectTab(tab.id)}>
              {t('terminal.reconnectNow')}
            </Button>
            <Button size="small" onClick={() => void closeTab(tab.id)}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      )}

      {closed && (
        <div className={styles.overlay}>
          <div className={`${styles.overlayText} ${styles.overlayError}`}>
            {tab.error ?? t('terminal.disconnected')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              size="small"
              type="primary"
              disabled={!profile}
              onClick={() => void reconnectTab(tab.id)}
            >
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

  if (menuItems.length === 0) return paneBody

  return (
    <Dropdown
      trigger={['contextMenu']}
      open={contextMenuOpen}
      onOpenChange={setContextMenuOpen}
      menu={{ items: menuItems, onClick: ({ key }) => onMenuClick(key) }}
    >
      {paneBody}
    </Dropdown>
  )
}
