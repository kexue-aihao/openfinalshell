import { useEffect } from 'react'
import { App as AntdApp, ConfigProvider } from 'antd'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useAppLanguage, useAppTheme, useUiZoom } from '@/hooks/useWindowShell'
import { EditorWindowShell } from '@/features/editor/EditorWindowShell'
import { ErrorBoundary } from '@/components/ErrorBoundary'

/**
 * 独立编辑器窗口的 App 根（URL hash `#/editor` 时由 main.tsx 选中渲染）。
 *
 * 与主窗口 App 的关系：主题/语言/缩放共用 useWindowShell 那一份实现；
 * 但**不**做主窗口的那些接线（wireSessionEvents / wireTermData / 传输 / 监控……）——
 * 那些 store 服务的是会话界面，这个窗口只有编辑器，接了它们等于每个事件
 * 都要在两个窗口里各处理一遍。
 *
 * settings 的 init 是幂等的（模块级 initialized 守卫），两个窗口各自的 renderer
 * 进程各 init 各的，互不相干；settings:changed 由 main 广播到两个窗口。
 */
export default function EditorWindowApp(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const init = useSettingsStore((s) => s.init)
  const { t } = useTranslation()

  useEffect(() => {
    void init()
  }, [init])

  const { antdTheme } = useAppTheme(settings)
  const { antdLocale, langReady } = useAppLanguage(settings)
  useUiZoom(settings)

  // 任务栏/Alt+Tab 里这个窗口叫什么（随语言热更）
  useEffect(() => {
    if (langReady) document.title = t('editor.windowTitle')
  }, [langReady, t])

  if (!settings || !langReady)
    return <div style={{ height: '100%', background: 'var(--ofs-bg-base)' }} />

  return (
    <ConfigProvider locale={antdLocale} theme={antdTheme}>
      <AntdApp style={{ height: '100%' }}>
        <ErrorBoundary label="editor-window-root">
          <EditorWindowShell />
        </ErrorBoundary>
      </AntdApp>
    </ConfigProvider>
  )
}
