import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { TerminalPane } from '@/features/terminal/TerminalPane'
import { SftpPane } from '@/features/sftp/SftpPane'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { SessionTab } from '@/stores/useSessionStore'
import styles from './SessionView.module.css'

interface Props {
  tabs: SessionTab[]
  activeTabId: string | null
  uiMode: 'dark' | 'light'
}

/**
 * 会话视图宿主：所有 tab 常驻挂载、绝对定位叠放（非活动用 visibility:hidden 保布局尺寸）。
 * 每个 tab 内：终端 + 可选的 SFTP 下方分屏（FinalShell 同款位置）。
 */
export function SessionViewHost({ tabs, activeTabId, uiMode }: Props): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)!
  const patch = useSettingsStore((s) => s.patch)

  return (
    <div className={styles.host}>
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        return (
          <div key={tab.id} className={`${styles.view} ${active ? styles.viewActive : ''}`}>
            <ErrorBoundary label={`session:${tab.id}`}>
              {tab.sftpOpen ? (
                <PanelGroup
                  direction="vertical"
                  onLayout={(sizes) => {
                    if (active && sizes.length >= 2) {
                      patch({ layout: { ...settings.layout, sftpPaneHeightPct: sizes[1] } })
                    }
                  }}
                >
                  <Panel id="term" order={1} minSize={20}>
                    <TerminalPane tab={tab} active={active} uiMode={uiMode} />
                  </Panel>
                  <PanelResizeHandle className="ofs-resize-handle" />
                  <Panel
                    id="sftp"
                    order={2}
                    defaultSize={settings.layout.sftpPaneHeightPct}
                    minSize={20}
                  >
                    <SftpPane tab={tab} active={active} />
                  </Panel>
                </PanelGroup>
              ) : (
                <TerminalPane tab={tab} active={active} uiMode={uiMode} />
              )}
            </ErrorBoundary>
          </div>
        )
      })}
    </div>
  )
}
