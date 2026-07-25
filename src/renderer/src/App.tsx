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
import { wireTransferEvents } from '@/stores/useTransferStore'
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

  if (!settings) return <div style={{ height: '100%', background: 'var(--ofs-bg-base)' }} />

  return (
    <ConfigProvider locale={settings.language === 'zh-CN' ? zhCN : enUS} theme={antdTheme}>
      <AntdApp style={{ height: '100%' }}>
        <ErrorBoundary label="app-root">
          <MainLayout uiMode={mode} />
          <ProfileEditDrawer />
          <PromptHost />
          <TransferDrawer />
        </ErrorBoundary>
      </AntdApp>
    </ConfigProvider>
  )
}
