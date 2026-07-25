import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { TitleBar } from './TitleBar'
import { ActivityBar } from './ActivityBar'
import { SidePanel } from './SidePanel'
import { StatusBar } from './StatusBar'
import { WelcomePage } from './WelcomePage'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { SessionViewHost } from '@/features/sessions/SessionView'
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
              if (!layout.sidePanelCollapsed && sizes.length >= 2) {
                patch({ layout: { ...layout, sidePanelSizePct: sizes[0] } })
              }
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
          </PanelGroup>
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
