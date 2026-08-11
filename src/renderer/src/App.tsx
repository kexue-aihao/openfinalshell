import { useEffect } from 'react'
import { App as AntdApp, ConfigProvider } from 'antd'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useAppLanguage, useAppTheme, useUiZoom } from '@/hooks/useWindowShell'
import { wireSessionEvents } from '@/stores/useSessionStore'
import { wireTermData } from '@/features/terminal/termRegistry'
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts'
import { MainLayout } from '@/features/layout/MainLayout'
import { ProfileEditDrawer } from '@/features/connections/ProfileEditDrawer'
import { PromptHost } from '@/features/prompts/PromptHost'
import { TransferDrawer } from '@/features/transfers/TransferDrawer'
import { SettingsModal } from '@/features/settings/SettingsModal'
import { CommandEditorModal } from '@/features/snippets/CommandEditorModal'
import { StartupNoticeModal } from '@/features/onboarding/StartupNoticeModal'
import { useTransferStore, wireTransferEvents } from '@/stores/useTransferStore'
import { wireMonitorEvents } from '@/stores/useMonitorStore'
import { wireForwardEvents } from '@/stores/useForwardStore'
import { wireUpdateEvents } from '@/stores/useUpdateStore'
import { wireLanSyncEvents } from '@/stores/useLanSyncStore'
import { ErrorBoundary } from '@/components/ErrorBoundary'

export default function App(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const init = useSettingsStore((s) => s.init)

  useGlobalShortcuts()

  useEffect(() => {
    void init()
    wireSessionEvents()
    wireTermData()
    wireTransferEvents()
    // 先订阅、后拉快照：反过来会漏掉这中间到达的事件（load 是合并语义，不会盖掉它们）
    void useTransferStore.getState().load()
    wireMonitorEvents()
    wireForwardEvents()
    wireUpdateEvents()
    wireLanSyncEvents()
  }, [init])

  // 主题 / 语言 / 缩放：与独立编辑器窗口共用同一份实现（见 useWindowShell.ts）
  const { mode, antdTheme } = useAppTheme(settings)
  const { antdLocale, langReady } = useAppLanguage(settings)
  useUiZoom(settings)

  if (!settings || !langReady)
    return <div style={{ height: '100%', background: 'var(--ofs-bg-base)' }} />

  return (
    <ConfigProvider locale={antdLocale} theme={antdTheme}>
      <AntdApp style={{ height: '100%' }}>
        <ErrorBoundary label="app-root">
          <MainLayout uiMode={mode} />
          <ProfileEditDrawer />
          <PromptHost />
          <TransferDrawer />
          <SettingsModal />
          {/* 挂在这里而不是快捷命令面板里：侧栏切到别的视图时那个面板会卸载，
              而命令编辑器开着的时候不该跟着消失（草稿也就跟着没了） */}
          <CommandEditorModal />
          {/* 开机弹窗：全新安装弹功能/快捷键引导，增量更新弹更新说明；同版本只弹一次 */}
          <StartupNoticeModal />
        </ErrorBoundary>
      </AntdApp>
    </ConfigProvider>
  )
}
