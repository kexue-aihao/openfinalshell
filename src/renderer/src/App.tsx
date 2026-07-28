import { useEffect, useMemo, useState } from 'react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { wireSessionEvents } from '@/stores/useSessionStore'
import { wireTermData } from '@/features/terminal/termRegistry'
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts'
import { applyCssVars, buildAntdTheme } from '@/themes/applyTheme'
import { MainLayout } from '@/features/layout/MainLayout'
import { ProfileEditDrawer } from '@/features/connections/ProfileEditDrawer'
import { PromptHost } from '@/features/prompts/PromptHost'
import { TransferDrawer } from '@/features/transfers/TransferDrawer'
import { SettingsModal } from '@/features/settings/SettingsModal'
import { CommandEditorModal } from '@/features/snippets/CommandEditorModal'
import { wireTransferEvents } from '@/stores/useTransferStore'
import { wireMonitorEvents } from '@/stores/useMonitorStore'
import { wireForwardEvents } from '@/stores/useForwardStore'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import i18n from '@/i18n'

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}

export default function App(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const init = useSettingsStore((s) => s.init)
  const systemDark = useSystemDark()

  useGlobalShortcuts()

  useEffect(() => {
    void init()
    wireSessionEvents()
    wireTermData()
    wireTransferEvents()
    wireMonitorEvents()
    wireForwardEvents()
  }, [init])

  const mode: 'dark' | 'light' = useMemo(() => {
    if (!settings) return 'dark'
    return settings.themeMode === 'system' ? (systemDark ? 'dark' : 'light') : settings.themeMode
  }, [settings, systemDark])

  const accent = settings?.accent ?? '#1677ff'

  // 主题双输出：CSS 变量（同步执行，避免闪烁）+ antd ThemeConfig
  useMemo(() => applyCssVars(mode, accent), [mode, accent])
  const antdTheme = useMemo(() => buildAntdTheme(mode, accent), [mode, accent])

  useEffect(() => {
    if (settings && i18n.language !== settings.language) {
      void i18n.changeLanguage(settings.language)
    }
  }, [settings])

  // 界面缩放：改根字号 + zoom，xterm 会随容器 ResizeObserver 自适应
  useEffect(() => {
    const zoom = (settings?.uiZoom ?? 100) / 100
    document.documentElement.style.setProperty('zoom', String(zoom))
  }, [settings?.uiZoom])

  if (!settings) return <div style={{ height: '100%', background: 'var(--ofs-bg-base)' }} />

  return (
    <ConfigProvider locale={settings.language === 'zh-CN' ? zhCN : enUS} theme={antdTheme}>
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
        </ErrorBoundary>
      </AntdApp>
    </ConfigProvider>
  )
}
