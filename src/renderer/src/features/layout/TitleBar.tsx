import { useRef, useState } from 'react'
import { Dropdown, Input } from 'antd'
import { Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSessionStore, type SessionTab } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useUiStore } from '@/stores/useUiStore'
import styles from './TitleBar.module.css'

function stateDotClass(tab: SessionTab): string {
  if (tab.state === 'ready') return styles.dotReady
  if (tab.state === 'closed') return styles.dotClosed
  return styles.dotConnecting
}

function tabMenuItems(tab: SessionTab, t: (key: string) => string) {
  const closeItems = [
    { key: 'close', label: t('tab.close') },
    { key: 'closeOthers', label: t('tab.closeOthers') },
    { key: 'closeToRight', label: t('tab.closeToRight') },
    { key: 'closeAll', label: t('tab.closeAll'), danger: true }
  ]
  if (tab.kind === 'portTraffic') return closeItems
  return [
    { key: 'rename', label: t('tab.rename') },
    { key: 'duplicate', label: t('tab.duplicate') },
    { key: 'reconnect', label: t('tab.reconnect') },
    { type: 'divider' as const },
    ...closeItems
  ]
}

/**
 * 标题栏 + 标签栏合一（titleBarOverlay：右侧原生窗口按钮由系统绘制）。
 * 标签区必须 no-drag，否则点击/双击重命名全部失效。
 */
export function TitleBar(): React.JSX.Element {
  const { t } = useTranslation()
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const setActiveTab = useSessionStore((s) => s.setActiveTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const closeOthers = useSessionStore((s) => s.closeOthers)
  const closeToRight = useSessionStore((s) => s.closeToRight)
  const duplicateTab = useSessionStore((s) => s.duplicateTab)
  const reconnectTab = useSessionStore((s) => s.reconnectTab)
  const renameTab = useSessionStore((s) => s.renameTab)
  const profiles = useConnectionStore((s) => s.profiles)
  const setEditingProfile = useUiStore((s) => s.setEditingProfile)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const tabRefs = useRef(new Map<string, HTMLDivElement>())

  const startRename = (tab: SessionTab): void => {
    setRenamingId(tab.id)
    setRenameValue(tab.customTitle ?? tab.title)
  }

  const commitRename = (): void => {
    if (renamingId && renameValue.trim()) renameTab(renamingId, renameValue.trim())
    setRenamingId(null)
  }

  const onMenuClick = (tab: SessionTab, key: string): void => {
    if (key === 'rename') startRename(tab)
    else if (key === 'duplicate') void duplicateTab(tab.id, profiles)
    else if (key === 'reconnect') void reconnectTab(tab.id)
    else if (key === 'close') void closeTab(tab.id)
    else if (key === 'closeOthers') void closeOthers(tab.id)
    else if (key === 'closeToRight') void closeToRight(tab.id)
    else if (key === 'closeAll') {
      for (const t2 of [...tabs]) void closeTab(t2.id)
    }
  }

  const activateTabAt = (index: number): void => {
    if (tabs.length === 0) return
    const next = tabs[(index + tabs.length) % tabs.length]
    setActiveTab(next.id)
    requestAnimationFrame(() => tabRefs.current.get(next.id)?.focus())
  }

  return (
    <header className={styles.titleBar}>
      <div className={styles.brand}>
        <span className={styles.logoDot} />
        {t('app.name')}
      </div>
      <div className={styles.tabStrip} role="tablist" aria-label={t('app.name')}>
        {tabs.map((tab, index) => (
          <Dropdown
            key={tab.id}
            trigger={['contextMenu']}
            menu={{
              items: tabMenuItems(tab, t),
              onClick: ({ key }) => onMenuClick(tab, key)
            }}
          >
            <div
              role="tab"
              ref={(element) => {
                if (element) tabRefs.current.set(tab.id, element)
                else tabRefs.current.delete(tab.id)
              }}
              tabIndex={tab.id === activeTabId ? 0 : -1}
              aria-selected={tab.id === activeTabId}
              aria-label={tab.customTitle ?? tab.title}
              className={`${styles.tab} ${tab.id === activeTabId ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => {
                if (renamingId === tab.id) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setActiveTab(tab.id)
                }
                if (e.key === 'Delete') void closeTab(tab.id)
                if (e.key === 'ArrowRight') {
                  e.preventDefault()
                  activateTabAt(index + 1)
                }
                if (e.key === 'ArrowLeft') {
                  e.preventDefault()
                  activateTabAt(index - 1)
                }
                if (e.key === 'Home') {
                  e.preventDefault()
                  activateTabAt(0)
                }
                if (e.key === 'End') {
                  e.preventDefault()
                  activateTabAt(tabs.length - 1)
                }
              }}
              onDoubleClick={() => startRename(tab)}
              onAuxClick={(e) => {
                if (e.button === 1) void closeTab(tab.id)
              }}
            >
              <span
                className={`${styles.stateDot} ${stateDotClass(tab)}`}
                style={tab.color ? { boxShadow: `0 0 0 2px ${tab.color}55` } : undefined}
              />
              {renamingId === tab.id ? (
                <Input
                  size="small"
                  autoFocus
                  variant="borderless"
                  style={{ padding: 0, height: 20, fontSize: 12 }}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onPressEnter={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className={styles.tabTitle}>{tab.customTitle ?? tab.title}</span>
              )}
              <button
                type="button"
                className={styles.tabClose}
                aria-label={`${t('tab.close')}: ${tab.customTitle ?? tab.title}`}
                title={t('tab.close')}
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTab(tab.id)
                }}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          </Dropdown>
        ))}
        <button
          type="button"
          className={styles.newTabBtn}
          aria-label={t('sidebar.newConnection')}
          title={t('sidebar.newConnection')}
          onClick={() => setEditingProfile('new')}
        >
          <Plus size={16} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  )
}
