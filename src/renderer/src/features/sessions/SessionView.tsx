import { ErrorBoundary } from '@/components/ErrorBoundary'
import { TerminalPane } from '@/features/terminal/TerminalPane'
import type { SessionTab } from '@/stores/useSessionStore'
import styles from './SessionView.module.css'

interface Props {
  tabs: SessionTab[]
  activeTabId: string | null
  uiMode: 'dark' | 'light'
}

/**
 * 会话视图宿主：所有 tab 的视图常驻挂载、绝对定位叠放。
 * SFTP 分屏（M3）与监控面板（M4）在此内嵌接入。
 */
export function SessionViewHost({ tabs, activeTabId, uiMode }: Props): React.JSX.Element {
  return (
    <div className={styles.host}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`${styles.view} ${tab.id === activeTabId ? styles.viewActive : ''}`}
        >
          <ErrorBoundary label={`session:${tab.id}`}>
            <TerminalPane tab={tab} active={tab.id === activeTabId} uiMode={uiMode} />
          </ErrorBoundary>
        </div>
      ))}
    </div>
  )
}
