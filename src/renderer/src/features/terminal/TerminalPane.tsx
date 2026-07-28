import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Dropdown, Spin } from 'antd'
import { Activity, Eraser, FolderTree, History, Search, Unplug } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ofs } from '@/ipc/api'
import { useHistoryStore } from '@/stores/useHistoryStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore, type SessionTab } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { TitlebarSafeTooltip } from '@/components/TitlebarSafeTooltip'
import { captureCommand } from './commandCapture'
import { createTerminal, type TerminalBundle } from './createTerminal'
import { noteProgrammaticWrite, registerTerm, trackerFor, unregisterTerm } from './termRegistry'
import { HistoryOverlay } from './HistoryOverlay'
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
  const [historyOpen, setHistoryOpen] = useState(false)
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

  /**
   * 往当前终端写一段**程序生成**的文本（粘贴、命令历史回填）。
   *
   * 写之前先 `noteProgrammaticWrite`：这一行的"提示符末尾列"就此不可信 ——
   * 光标被写进去的内容推走了，而它不是用户敲的。不标记的话，用户在回填的命令后面
   * 再补几个字符然后回车，记进历史的就只有他补的那几个字符（语义见 commandCapture.ts）。
   */
  const writeToTerm = useCallback((data: string): void => {
    const termId = termIdRef.current
    if (!termId) return
    noteProgrammaticWrite(termId)
    ofs.send('term:input', { termId, data })
  }, [])

  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    const text = await navigator.clipboard.readText().catch(() => '')
    if (!text || !termIdRef.current) return
    const doPaste = (): void => writeToTerm(text)
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
  }, [modal, settings.terminal.confirmMultilinePaste, t, writeToTerm])

  // ---- 创建 xterm 实例（tab 存续期间常驻，重连不重建） ----
  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const bundle = createTerminal(settings, uiMode)
    bundleRef.current = bundle
    bundle.term.open(el)

    bundle.term.onData((data) => {
      const termId = termIdRef.current
      if (!termId) return
      /*
       * 命令历史采集的第一半：这一行第一次有输入时，光标正停在提示符末尾。
       * 挂在 onData 而不是键盘事件上，是为了把输入法上屏也算进来 ——
       * 中文候选是经 onData 提交的，没有对应的 keydown。
       */
      trackerFor(termId).noteKeystroke(bundle.term.buffer.active)
      ofs.send('term:input', { termId, data })
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
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyH') {
        setHistoryOpen(true)
        return false
      }
      /*
       * 命令历史采集的第二半：回车**按下**的这一刻，shell 还没处理它，
       * 屏幕上那一行就是即将执行的命令。切法与三道守卫都在 commandCapture.ts。
       *
       * 一律 `return true` —— 采集不许影响回车本身。真出了异常也只是这一条没记上，
       * 绝不能让终端吞掉一次回车（那是"这个软件坏了"级别的表现）。
       */
      if (ev.key === 'Enter' && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
        try {
          if (useSettingsStore.getState().settings?.terminal.saveCommandHistory) {
            const termId = termIdRef.current
            const command = termId
              ? captureCommand(bundle.term.buffer.active, trackerFor(termId))
              : null
            if (command) useHistoryStore.getState().push(command)
          }
        } catch {
          /* 采集永不阻断按键 */
        }
        return true
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
        const dying = termIdRef.current
        unregisterTerm(dying)
        void ofs.invoke('term:close', dying).catch(() => {})
        termIdRef.current = null
        // 同步把 store 里的 termId 清掉。不清的话，万一本组件是被"重挂"而不是真的关掉
        // （父级结构变化就会这样），新实例会看到一个指向已关闭 shell 的 tab.termId，
        // 于是开 shell 的 effect 直接 return —— 留下一个永远空白、也不会自愈的终端。
        useSessionStore.setState((s) => ({
          tabs: s.tabs.map((t) => (t.termId === dying ? { ...t, termId: null } : t))
        }))
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
          { key: 'history', label: t('terminal.history') },
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
    else if (key === 'history') setHistoryOpen(true)
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
          <TitlebarSafeTooltip title={t('terminal.historyTip')}>
            <Button
              size="small"
              type={historyOpen ? 'primary' : 'text'}
              icon={<History size={14} strokeWidth={1.75} />}
              onClick={() => setHistoryOpen((v) => !v)}
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

      {historyOpen && (
        <HistoryOverlay
          onInsert={writeToTerm}
          onClose={() => {
            setHistoryOpen(false)
            bundleRef.current?.term.focus()
          }}
        />
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
