import { ArrowDownUp, ArrowLeftRight, Server, Settings, SunMoon, Zap } from 'lucide-react'
import { Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import type { SidebarView } from '@shared/types'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUiStore } from '@/stores/useUiStore'
import { useTransferStore } from '@/stores/useTransferStore'
import styles from './ActivityBar.module.css'

const VIEWS: Array<{ key: SidebarView; icon: typeof Server; labelKey: string }> = [
  { key: 'connections', icon: Server, labelKey: 'activity.connections' },
  { key: 'snippets', icon: Zap, labelKey: 'activity.snippets' },
  { key: 'forwards', icon: ArrowLeftRight, labelKey: 'activity.forwards' },
  { key: 'transfers', icon: ArrowDownUp, labelKey: 'activity.transfers' }
]

export function ActivityBar(): React.JSX.Element {
  const { t } = useTranslation()
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsStore((s) => s.patch)
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
  const activeTransfers = useTransferStore(
    (s) => s.tasks.filter((task) => task.state === 'running' || task.state === 'queued').length
  )

  if (!settings) return <nav className={styles.activityBar} />
  const { activeSidebar, sidePanelCollapsed } = settings.layout

  const onViewClick = (view: SidebarView): void => {
    if (view === activeSidebar) {
      // 再点当前项 = 折叠/展开左栏
      patch({ layout: { ...settings.layout, sidePanelCollapsed: !sidePanelCollapsed } })
    } else {
      patch({ layout: { ...settings.layout, activeSidebar: view, sidePanelCollapsed: false } })
    }
  }

  const toggleTheme = (): void => {
    const next = settings.themeMode === 'dark' ? 'light' : 'dark'
    patch({ themeMode: next })
  }

  return (
    <nav className={styles.activityBar}>
      {VIEWS.map(({ key, icon: Icon, labelKey }) => (
        <Tooltip key={key} title={t(labelKey)} placement="right">
          <button
            type="button"
            className={`${styles.item} ${activeSidebar === key && !sidePanelCollapsed ? styles.itemActive : ''}`}
            aria-label={t(labelKey)}
            aria-current={activeSidebar === key && !sidePanelCollapsed ? 'page' : undefined}
            title={t(labelKey)}
            onClick={() => onViewClick(key)}
          >
            <Icon size={18} strokeWidth={1.75} />
            {key === 'transfers' && activeTransfers > 0 && (
              <span className={styles.badge}>{activeTransfers}</span>
            )}
          </button>
        </Tooltip>
      ))}
      <div className={styles.spacer} />
      <Tooltip title={t('activity.toggleTheme')} placement="right">
        <button
          type="button"
          className={styles.item}
          aria-label={t('activity.toggleTheme')}
          title={t('activity.toggleTheme')}
          onClick={toggleTheme}
        >
          <SunMoon size={18} strokeWidth={1.75} />
        </button>
      </Tooltip>
      <Tooltip title={t('activity.settings')} placement="right">
        <button
          type="button"
          className={styles.item}
          aria-label={t('activity.settings')}
          title={t('activity.settings')}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={18} strokeWidth={1.75} />
        </button>
      </Tooltip>
    </nav>
  )
}
