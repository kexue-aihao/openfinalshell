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
                {tab.sftpOpen && (
                  <>
                    <PanelResizeHandle className="ofs-resize-handle" />
                    <Panel
                      id="sftp"
                      order={2}
                      defaultSize={settings.layout.sftpPaneHeightPct}
                      minSize={20}
                    >
                      <SftpPane tab={tab} active={active} />
                    </Panel>
                  </>
                )}
              </PanelGroup>
            </ErrorBoundary>
          </div>
        )
      })}
    </div>
  )
}
