import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { TerminalPane } from '@/features/terminal/TerminalPane'
import { SftpPane } from '@/features/sftp/SftpPane'
import { PortTrafficTab } from '@/features/portTraffic/PortTrafficTab'
import { RdpPane } from './RdpPane'
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
 * 内置编辑器不在这里 —— 它是一个独立窗口（EditorWindowShell），所有会话共用。
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
              {tab.kind === 'portTraffic' ? (
                <PortTrafficTab tab={tab} />
              ) : tab.kind === 'rdp' ? (
                <RdpPane tab={tab} active={active} />
              ) : (
              <>
              {/*
               * PanelGroup 与终端那一格**恒常挂载**，只有 SFTP 那一格随开关增删。
               *
               * 早先写成 `sftpOpen ? <PanelGroup><TerminalPane/>…</PanelGroup> : <TerminalPane/>`，
               * 开关 SFTP 时该位置的元素类型在 PanelGroup 与 TerminalPane 之间变化，
               * React 按位置+类型对账 → 整棵子树卸载重建。而 TerminalPane 卸载时会
               * invoke('term:close')，于是：开 SFTP 就把 shell 关了 → main 回 term:exit(closed)
               * → tab 被标成 closed → SftpPane 看到 state!=='ready' 直接显示"等待会话"，
               * 一个文件都拉不到。RTT 越高越必中（term:exit 是本地事件，跑得比 SFTP 往返快）。
               */}
              {/*
                * 尺寸持久化用**每个 Panel 自己的 onResize**，不用 PanelGroup 的 onLayout。
                * onLayout 给的是一个按顺序排的数组，此前写成 `sizes[1]` = SFTP 那一格 ——
                * 而内置编辑器进来之后 sizes[1] 变成了编辑器那一格，
                * 于是拖编辑器的分隔条会静默写进 sftpPaneHeightPct。
                * 按位置取值这件事只要面板数量变一次就错一次，而它不会报错、只会写错值。
                */}
              <PanelGroup direction="vertical">
                <Panel id="term" order={1} minSize={20}>
                  <TerminalPane tab={tab} active={active} uiMode={uiMode} />
                </Panel>
                {tab.sftpOpen && (
                  <>
                    <PanelResizeHandle className="ofs-resize-handle" />
                    <Panel
                      id="sftp"
                      order={3}
                      defaultSize={settings.layout.sftpPaneHeightPct}
                      minSize={20}
                      onResize={(size) => {
                        if (active) patch({ layout: { ...settings.layout, sftpPaneHeightPct: size } })
                      }}
                    >
                      <SftpPane tab={tab} active={active} />
                    </Panel>
                  </>
                )}
              </PanelGroup>
              </>
              )}
            </ErrorBoundary>
          </div>
        )
      })}
    </div>
  )
}
