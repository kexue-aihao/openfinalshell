import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useCallback, useEffect, useRef } from 'react'
import type { AppSettings } from '@shared/types'
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

// Keep the navigation rail usable at the minimum desktop window size while
// preventing a restored, stale percentage from swallowing the workspace.
const MIN_SIDE_PANEL_PCT = 22
const MAX_SIDE_PANEL_PCT = 32

export function MainLayout({ uiMode }: Props): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsStore((s) => s.patch)
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  // 停采集器现在收在 toggleMonitor 里（终端工具条那条路径绕不过去了）
  const toggleMonitor = useSessionStore((s) => s.toggleMonitor)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)

  // 拖分隔条时 onLayout 每帧都触发。立刻 patch 会每帧深拷贝 settings、
  // 往主进程发一次 IPC + 落盘；这里合并到 180ms 静默后再写一次。
  const pendingLayout = useRef<AppSettings['layout'] | null>(null)
  const layoutTimer = useRef<number | undefined>(undefined)
  const flushLayout = useCallback((): void => {
    if (layoutTimer.current !== undefined) {
      window.clearTimeout(layoutTimer.current)
      layoutTimer.current = undefined
    }
    const next = pendingLayout.current
    pendingLayout.current = null
    if (next) patch({ layout: next })
  }, [patch])
  // 关闭窗口前把最后一次拖拽结果补写进去
  useEffect(() => flushLayout, [flushLayout])

  if (!settings) return <div className={styles.root} />
  const { layout } = settings
  const sidePanelSize = Math.min(
    MAX_SIDE_PANEL_PCT,
    Math.max(MIN_SIDE_PANEL_PCT, layout.sidePanelSizePct)
  )

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
              if (!layout.sidePanelCollapsed) {
                next.sidePanelSizePct = Math.min(
                  MAX_SIDE_PANEL_PCT,
                  Math.max(MIN_SIDE_PANEL_PCT, sizes[0])
                )
              }
              if (activeTab?.monitorOpen) next.monitorPanelSizePct = sizes[sizes.length - 1]
              pendingLayout.current = next
              if (layoutTimer.current !== undefined) window.clearTimeout(layoutTimer.current)
              layoutTimer.current = window.setTimeout(flushLayout, 180)
            }}
          >
            {!layout.sidePanelCollapsed && (
              <>
                <Panel
                  id="side"
                  order={1}
                  defaultSize={sidePanelSize}
                  minSize={MIN_SIDE_PANEL_PCT}
                  maxSize={MAX_SIDE_PANEL_PCT}
                  style={{ display: 'flex', alignItems: 'stretch' }}
                >
                  <SidePanel />
                </Panel>
                <PanelResizeHandle className="ofs-resize-handle" />
              </>
            )}
            <Panel id="main" order={2} style={{ display: 'flex', alignItems: 'stretch' }}>
              <main className={styles.mainArea} tabIndex={-1}>
                <ErrorBoundary label="main-area">
                  {tabs.length === 0 ? (
                    <WelcomePage />
                  ) : (
                    <SessionViewHost tabs={tabs} activeTabId={activeTabId} uiMode={uiMode} />
                  )}
                </ErrorBoundary>
              </main>
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
                  style={{ display: 'flex', alignItems: 'stretch' }}
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
