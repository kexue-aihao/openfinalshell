import { Empty } from 'antd'
import { useTranslation } from 'react-i18next'
import type { SidebarView } from '@shared/types'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ConnectionTreePanel } from '@/features/connections/ConnectionTreePanel'
import { SnippetPanel } from '@/features/snippets/SnippetPanel'
import styles from './SidePanel.module.css'

const TITLE_KEY: Record<SidebarView, string> = {
  connections: 'sidebar.connections',
  snippets: 'sidebar.snippets',
  forwards: 'sidebar.forwards',
  transfers: 'sidebar.transfers'
}

const EMPTY_KEY: Record<SidebarView, string> = {
  connections: 'sidebar.emptyConnections',
  snippets: 'sidebar.emptySnippets',
  forwards: 'sidebar.emptyForwards',
  transfers: 'sidebar.emptyTransfers'
}

/**
 * 左侧面板：内容随活动栏切换。
 * M0 为空态骨架；ConnectionTreePanel(M1) / SnippetPanel(M2) / ForwardPanel(M5) / TransferPanel(M3) 逐步接入。
 */
export function SidePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const view = useSettingsStore((s) => s.settings?.layout.activeSidebar ?? 'connections')

  return (
    <aside className={styles.sidePanel}>
      <div className={styles.header}>{t(TITLE_KEY[view])}</div>
      <div className={styles.content}>
        <ErrorBoundary label={`sidebar:${view}`}>
          {view === 'connections' && <ConnectionTreePanel />}
          {view === 'snippets' && <SnippetPanel />}
          {(view === 'forwards' || view === 'transfers') && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t(EMPTY_KEY[view])}
              style={{ marginTop: 48 }}
            />
          )}
        </ErrorBoundary>
      </div>
    </aside>
  )
}
