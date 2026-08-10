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
import { StartupNoticeModal } from '@/features/onboarding/StartupNoticeModal'
import { useTransferStore, wireTransferEvents } from '@/stores/useTransferStore'
import { wireMonitorEvents } from '@/stores/useMonitorStore'
import { wireForwardEvents } from '@/stores/useForwardStore'
import { wireUpdateEvents } from '@/stores/useUpdateStore'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import i18n, { ensureBundle, isBundleLoaded } from '@/i18n'
import { ofs } from '@/ipc/api'
import { localeMeta } from '@shared/locales/registry'

type AntdLocale = typeof zhCN
/** en/zh 的 antd 语言包随主 bundle 内联；其余按需各成 chunk（避免主 bundle 变大） */
const ANTD_BASE: Record<string, AntdLocale> = { 'zh-CN': zhCN, 'en-US': enUS }
const ANTD_LOADERS: Record<string, () => Promise<{ default: AntdLocale }>> = {
  'zh-TW': () => import('antd/locale/zh_TW'),
  'ja-JP': () => import('antd/locale/ja_JP'),
  'ko-KR': () => import('antd/locale/ko_KR'),
  'ru-RU': () => import('antd/locale/ru_RU'),
  'es-ES': () => import('antd/locale/es_ES'),
  'fr-FR': () => import('antd/locale/fr_FR'),
  'de-DE': () => import('antd/locale/de_DE'),
  'pt-BR': () => import('antd/locale/pt_BR')
}

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
    // 先订阅、后拉快照：反过来会漏掉这中间到达的事件（load 是合并语义，不会盖掉它们）
    void useTransferStore.getState().load()
    wireMonitorEvents()
    wireForwardEvents()
    wireUpdateEvents()
  }, [init])

  const mode: 'dark' | 'light' = useMemo(() => {
    if (!settings) return 'dark'
    return settings.themeMode === 'system' ? (systemDark ? 'dark' : 'light') : settings.themeMode
  }, [settings, systemDark])

  const accent = settings?.accent ?? '#1677ff'

  // 主题双输出：CSS 变量（同步执行，避免闪烁）+ antd ThemeConfig
  useMemo(() => applyCssVars(mode, accent), [mode, accent])
  const antdTheme = useMemo(() => buildAntdTheme(mode, accent), [mode, accent])

  // 活动语言：en/zh 已内联可即时切；其余先向主进程取回语言包（i18n + antd）再切。
  // langReady 门控首屏，避免懒加载语言在包到位前先闪一屏英文。
  const [antdLocale, setAntdLocale] = useState<AntdLocale>(zhCN)
  const [langReady, setLangReady] = useState(false)
  useEffect(() => {
    const tag = settings?.language
    if (!tag) return
    let cancelled = false
    void (async () => {
      if (!isBundleLoaded(tag)) {
        try {
          const bundle = await ofs.invoke('i18n:bundle', tag)
          if (!cancelled) ensureBundle(tag, bundle)
        } catch {
          /* 取不到就回退 en（fallbackLng），changeLanguage 仍安全 */
        }
      }
      if (cancelled) return
      if (i18n.language !== tag) await i18n.changeLanguage(tag)
      let al: AntdLocale = ANTD_BASE[tag] ?? enUS
      const loader = ANTD_LOADERS[tag]
      if (loader) {
        try {
          al = (await loader()).default
        } catch {
          al = enUS
        }
      }
      if (cancelled) return
      setAntdLocale(al)
      document.documentElement.dir = localeMeta(tag).dir
      setLangReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [settings?.language])

  // 界面缩放：改根字号 + zoom，xterm 会随容器 ResizeObserver 自适应
  useEffect(() => {
    const zoom = (settings?.uiZoom ?? 100) / 100
    document.documentElement.style.setProperty('zoom', String(zoom))
  }, [settings?.uiZoom])

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
