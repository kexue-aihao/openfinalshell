import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { TitleBar } from './TitleBar'
import { ActivityBar } from './ActivityBar'
import { SidePanel } from './SidePanel'
import { StatusBar } from './StatusBar'
import { WelcomePage } from './WelcomePage'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { SessionViewHost } from '@/features/sessions/SessionView'
import { MonitorPanel } from '@/features/monitor/MonitorPanel'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import styles from './MainLayout.module.css'

interface Props {
  uiMode: 'dark' | 'light'
}

export function MainLayout({ uiMode }: Props): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsStore((s) => s.patch)
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  // 停采集器现在收在 toggleMonitor 里（终端工具条那条路径绕不过去了）
  const toggleMonitor = useSessionStore((s) => s.toggleMonitor)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)

  if (!settings) return <div className={styles.root} />
  const { layout } = settings

  return (
    <div className={styles.root}>
      <TitleBar />
      <div className={styles.body}>
        <ActivityBar />
        <div className={styles.panels}>
          <PanelGroup
            direction="horizontal"
            onLayout={(sizes) => {
              if (sizes.length < 2) return
              const next = { ...layout }
              if (!layout.sidePanelCollapsed) next.sidePanelSizePct = sizes[0]
              if (activeTab?.monitorOpen) next.monitorPanelSizePct = sizes[sizes.length - 1]
              patch({ layout: next })
            }}
          >
            {!layout.sidePanelCollapsed && (
              <>
                <Panel
                  id="side"
                  order={1}
                  defaultSize={layout.sidePanelSizePct}
                  minSize={12}
                  maxSize={40}
                >
                  <SidePanel />
                </Panel>
                <PanelResizeHandle className="ofs-resize-handle" />
              </>
            )}
            <Panel id="main" order={2}>
              <div className={styles.mainArea}>
                <ErrorBoundary label="main-area">
                  {tabs.length === 0 ? (
                    <WelcomePage />
                  ) : (
                    <SessionViewHost tabs={tabs} activeTabId={activeTabId} uiMode={uiMode} />
                  )}
                </ErrorBoundary>
              </div>
            </Panel>
            {activeTab?.monitorOpen && (
              <>
                <PanelResizeHandle className="ofs-resize-handle" />
                <Panel
                  id="monitor"
                  order={3}
                  defaultSize={layout.monitorPanelSizePct}
                  minSize={14}
                  maxSize={40}
                >
                  <ErrorBoundary label="monitor">
                    <MonitorPanel tab={activeTab} onClose={() => toggleMonitor(activeTab.id)} />
                  </ErrorBoundary>
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
