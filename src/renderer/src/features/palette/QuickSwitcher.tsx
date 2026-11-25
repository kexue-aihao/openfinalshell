import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { App as AntdApp } from 'antd'
import { useTranslation } from 'react-i18next'
import { CornerDownLeft, Search } from 'lucide-react'
import { useUiStore } from '@/stores/useUiStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import styles from './QuickSwitcher.module.css'

interface Entry {
  id: string
  group: 'sessions' | 'connections'
  title: string
  subtitle: string
  tag: string
  /** 当前活动标签：列表里加一个小圆点，避免"看起来能点、点了没反应"的错觉 */
  active?: boolean
  run: () => void
}

/**
 * Ctrl/Cmd+K 快速切换器。
 *
 * 与 WinUI 侧 MainWindow.Palette.cs 对齐：先列已打开的标签、再列已保存的连接，
 * 选中标签即激活，选中连接即走 launchProfile（RDP 会自动分派）。
 * 挂在 App 层常驻，侧栏切视图不会把它的查询状态弄丢。
 */
export function QuickSwitcher(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const open = useUiStore((s) => s.quickSwitcherOpen)
  const setOpen = useUiStore((s) => s.setQuickSwitcherOpen)
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const setActiveTab = useSessionStore((s) => s.setActiveTab)
  const launchProfile = useSessionStore((s) => s.launchProfile)
  const profiles = useConnectionStore((s) => s.profiles)

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  const close = useCallback((): void => setOpen(false), [setOpen])

  // 打开时清空查询、聚焦输入框；关闭时把焦点还给打开前的元素。
  // loaded 通过 getState 读取而不是进依赖数组：否则连接列表加载完成会重跑本效果，
  // 把用户刚输入的查询清掉、输入框重新 focus。
  useEffect(() => {
    if (!open) return
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setIndex(0)
    if (!useConnectionStore.getState().loaded) {
      void useConnectionStore.getState().load().catch(() => {})
    }
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      cancelAnimationFrame(raf)
      restoreFocus.current?.focus({ preventScroll: true })
      restoreFocus.current = null
    }
  }, [open])

  const entries = useMemo<Entry[]>(() => {
    const profileById = new Map(profiles.map((p) => [p.id, p]))
    const sessionEntries: Entry[] = tabs.map((tab) => {
      const profile = profileById.get(tab.profileId)
      const kind = tab.kind ?? 'terminal'
      return {
        id: `tab:${tab.id}`,
        group: 'sessions',
        title: tab.customTitle ?? tab.title,
        subtitle: profile ? `${profile.username}@${profile.host}:${profile.port}` : '',
        tag: kind === 'rdp' ? 'RDP' : kind === 'portTraffic' ? t('portTraffic.tab') : 'SSH',
        active: tab.id === activeTabId,
        run: () => setActiveTab(tab.id)
      }
    })
    const connectionEntries: Entry[] = profiles.map((profile) => ({
      id: `profile:${profile.id}`,
      group: 'connections',
      title: profile.name,
      subtitle: `${profile.username}@${profile.host}:${profile.port}`,
      tag: profile.protocol === 'rdp' ? 'RDP' : 'SSH',
      run: () => {
        void launchProfile(profile).catch((err) => {
          message.error(err instanceof Error ? err.message : String(err))
        })
      }
    }))
    return [...sessionEntries, ...connectionEntries]
  }, [tabs, profiles, activeTabId, setActiveTab, launchProfile, message, t])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((entry) =>
      `${entry.title}\n${entry.subtitle}\n${entry.tag}`.toLowerCase().includes(q)
    )
  }, [entries, query])

  // 查询变化后把高亮回落到第一项；过滤结果变短时也不会指向不存在的下标。
  useEffect(() => setIndex(0), [query])
  const activeIndex = Math.min(index, Math.max(0, filtered.length - 1))

  useEffect(() => {
    if (!open) return
    const item = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`)
    // jsdom 等环境里 scrollIntoView 可能不是函数，别为此炸掉整个面板
    if (typeof item?.scrollIntoView === 'function') item.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  if (!open) return null

  const activate = (entry: Entry | undefined): void => {
    if (!entry) return
    entry.run()
    close()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // 中文输入法组词期间，↑↓/Enter 属于 IME 候选词选择，不能拿来切条目
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (filtered.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setIndex((activeIndex + delta + filtered.length) % filtered.length)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (filtered.length === 0) return
      setIndex(event.key === 'Home' ? 0 : filtered.length - 1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      activate(filtered[activeIndex])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return createPortal(
    <div
      className={styles.scrim}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onKeyDown={(event) => {
          // 焦点被点到列表外的容器上时，Esc 仍然能关
          if (event.key === 'Escape') close()
        }}
      >
        <div className={styles.searchRow}>
          <Search size={15} strokeWidth={1.9} className={styles.searchIcon} aria-hidden />
          <input
            ref={inputRef}
            className={styles.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            aria-controls="ofs-palette-list"
            aria-activedescendant={filtered.length > 0 ? `ofs-palette-item-${activeIndex}` : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          <span className={styles.kbd}>Esc</span>
        </div>

        <div className={styles.list} id="ofs-palette-list" role="listbox" ref={listRef}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>{t('palette.empty')}</div>
          ) : (
            filtered.map((entry, i) => (
              <Fragment key={entry.id}>
                {(i === 0 || filtered[i - 1].group !== entry.group) && (
                  <div className={styles.groupLabel} role="presentation">
                    {t(entry.group === 'sessions' ? 'palette.sessions' : 'palette.connections')}
                  </div>
                )}
                <div
                  id={`ofs-palette-item-${i}`}
                  data-palette-index={i}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`${styles.item} ${i === activeIndex ? styles.itemActive : ''}`}
                  onPointerDown={(event) => {
                    // preventDefault：别让输入框先失焦，否则 pointerup 时选择态已经丢了
                    event.preventDefault()
                    activate(entry)
                  }}
                  onPointerMove={() => {
                    if (i !== activeIndex) setIndex(i)
                  }}
                >
                  <span className={styles.itemText}>
                    <span className={styles.itemTitle}>
                      {entry.active && <span className={styles.activeDot} aria-hidden />}
                      {entry.title}
                    </span>
                    {entry.subtitle && <span className={styles.itemSubtitle}>{entry.subtitle}</span>}
                  </span>
                  <span className={styles.tag}>{entry.tag}</span>
                </div>
              </Fragment>
            ))
          )}
        </div>

        <div className={styles.footer}>
          <CornerDownLeft size={12} strokeWidth={1.9} aria-hidden />
          <span>{t('palette.hint')}</span>
        </div>
      </div>
    </div>,
    document.body
  )
}
