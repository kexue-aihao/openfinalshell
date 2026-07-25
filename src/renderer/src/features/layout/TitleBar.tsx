import { useState } from 'react'
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

  return (
    <header className={styles.titleBar}>
      <div className={styles.brand}>
        <span className={styles.logoDot} />
        {t('app.name')}
      </div>
      <div className={styles.tabStrip}>
        {tabs.map((tab) => (
          <Dropdown
            key={tab.id}
            trigger={['contextMenu']}
            menu={{
              items: [
                { key: 'rename', label: t('tab.rename') },
                { key: 'duplicate', label: t('tab.duplicate') },
                { key: 'reconnect', label: t('tab.reconnect') },
                { type: 'divider' },
                { key: 'close', label: t('tab.close') },
                { key: 'closeOthers', label: t('tab.closeOthers') },
                { key: 'closeToRight', label: t('tab.closeToRight') },
                { key: 'closeAll', label: t('tab.closeAll'), danger: true }
              ],
              onClick: ({ key }) => onMenuClick(tab, key)
            }}
          >
            <div
              className={`${styles.tab} ${tab.id === activeTabId ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.id)}
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
          title={t('sidebar.newConnection')}
          onClick={() => setEditingProfile('new')}
        >
          <Plus size={16} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  )
}
