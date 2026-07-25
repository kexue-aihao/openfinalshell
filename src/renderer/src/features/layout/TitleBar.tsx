import { Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSessionStore, type SessionTab } from '@/stores/useSessionStore'
import { useUiStore } from '@/stores/useUiStore'
import styles from './TitleBar.module.css'

function stateDotClass(tab: SessionTab): string {
  if (tab.state === 'ready') return styles.dotReady
  if (tab.state === 'closed') return styles.dotClosed
  return styles.dotConnecting
}

/**
 * 标题栏 + 标签栏合一（titleBarOverlay：右侧原生窗口按钮由系统绘制）。
 */
export function TitleBar(): React.JSX.Element {
  const { t } = useTranslation()
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const setActiveTab = useSessionStore((s) => s.setActiveTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const setEditingProfile = useUiStore((s) => s.setEditingProfile)

  return (
    <header className={styles.titleBar}>
      <div className={styles.brand}>
        <span className={styles.logoDot} />
        {t('app.name')}
      </div>
      <div className={styles.tabStrip}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`${styles.tab} ${tab.id === activeTabId ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab.id)}
            onAuxClick={(e) => {
              if (e.button === 1) void closeTab(tab.id)
            }}
          >
            <span
              className={`${styles.stateDot} ${stateDotClass(tab)}`}
              style={tab.color ? { boxShadow: `0 0 0 2px ${tab.color}33` } : undefined}
            />
            <span className={styles.tabTitle}>{tab.customTitle ?? tab.title}</span>
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
