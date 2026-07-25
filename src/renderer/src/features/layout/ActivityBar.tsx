import { ArrowDownUp, ArrowLeftRight, Server, Settings, SunMoon, Zap } from 'lucide-react'
import { Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import type { SidebarView } from '@shared/types'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUiStore } from '@/stores/useUiStore'
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
            onClick={() => onViewClick(key)}
          >
            <Icon size={18} strokeWidth={1.75} />
          </button>
        </Tooltip>
      ))}
      <div className={styles.spacer} />
      <Tooltip title={t('activity.toggleTheme')} placement="right">
        <button type="button" className={styles.item} onClick={toggleTheme}>
          <SunMoon size={18} strokeWidth={1.75} />
        </button>
      </Tooltip>
      <Tooltip title={t('activity.settings')} placement="right">
        <button type="button" className={styles.item} onClick={() => setSettingsOpen(true)}>
          <Settings size={18} strokeWidth={1.75} />
        </button>
      </Tooltip>
    </nav>
  )
}
