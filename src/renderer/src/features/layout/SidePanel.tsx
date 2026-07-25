import { useTranslation } from 'react-i18next'
import type { SidebarView } from '@shared/types'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ConnectionTreePanel } from '@/features/connections/ConnectionTreePanel'
import { SnippetPanel } from '@/features/snippets/SnippetPanel'
import { TransferList } from '@/features/transfers/TransferList'
import { ForwardPanel } from '@/features/forwarding/ForwardPanel'
import styles from './SidePanel.module.css'

const TITLE_KEY: Record<SidebarView, string> = {
  connections: 'sidebar.connections',
  snippets: 'sidebar.snippets',
  forwards: 'sidebar.forwards',
  transfers: 'sidebar.transfers'
}

/** 左侧面板：内容随活动栏切换；各视图自己处理空态。 */
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
          {view === 'transfers' && <TransferList compact />}
          {view === 'forwards' && <ForwardPanel />}
        </ErrorBoundary>
      </div>
    </aside>
  )
}
