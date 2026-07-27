import { useMemo } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { EditorHost } from '@/features/editor/EditorHost'
import { TerminalPane } from '@/features/terminal/TerminalPane'
import { SftpPane } from '@/features/sftp/SftpPane'
import { useEditorStore } from '@/stores/useEditorStore'
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
 * 每个 tab 内：终端 + 可选的内置编辑器 + 可选的 SFTP 下方分屏（FinalShell 同款位置）。
 */
export function SessionViewHost({ tabs, activeTabId, uiMode }: Props): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)!
  const patch = useSettingsStore((s) => s.patch)
  /*
   * 只订阅"有哪些会话开着文件"这一件事，不订阅 files 本身：后者每读完一个文件就变一次
   * （2MB 的正文就在里面），而这里只需要知道那一格在不在 —— 订阅整个 files
   * 会让每次打开/重读文件都把所有会话的整棵子树重渲染一遍，包括终端那一格。
   * 选择器返回**字符串**而不是 Set：zustand 按引用比较，每次返回新 Set 等于每次都变。
   */
  const sessionsWithFiles = useEditorStore((s) =>
    [...new Set(s.files.map((f) => f.sessionId))].sort().join(',')
  )
  const openSessions = useMemo(
    () => new Set(sessionsWithFiles.split(',').filter(Boolean)),
    [sessionsWithFiles]
  )

  return (
    <div className={styles.host}>
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        const editorOpen = tab.sessionId ? openSessions.has(tab.sessionId) : false
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
                {/*
                  * 编辑器那一格没有开关：打开过文件就在，标签全关掉就没了。
                  * 位置在终端与 SFTP 之间 —— 用户是从 SFTP 里点开文件的，
                  * 让新出现的那一格紧贴着来源，比插在最下面更好找。
                  */}
                {editorOpen && (
                  <>
                    <PanelResizeHandle className="ofs-resize-handle" />
                    <Panel
                      id="editor"
                      order={2}
                      defaultSize={settings.layout.editorPaneHeightPct}
                      minSize={15}
                      onResize={(size) => {
                        if (active) patch({ layout: { ...settings.layout, editorPaneHeightPct: size } })
                      }}
                    >
                      <EditorHost tab={tab} />
                    </Panel>
                  </>
                )}
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
            </ErrorBoundary>
          </div>
        )
      })}
    </div>
  )
}
