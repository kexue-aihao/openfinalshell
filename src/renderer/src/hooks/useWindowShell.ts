import { useEffect, useMemo, useState } from 'react'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import type { ThemeConfig } from 'antd'
import type { AppSettings } from '@shared/types'
import { applyCssVars, buildAntdTheme } from '@/themes/applyTheme'
import i18n, { ensureBundle, isBundleLoaded } from '@/i18n'
import { ofs } from '@/ipc/api'
import { localeMeta } from '@shared/locales/registry'
import { resolvePlatformUiProfile } from '@/ui/platform'

/**
 * 窗口外壳的公共部分：主题、语言、缩放。
 *
 * 抽成 hook 是因为现在有**两个** BrowserWindow 各自渲染一份 React 树（主窗口 App 与
 * 独立编辑器窗口 EditorWindowApp），这些逻辑必须逐字节一致 —— 各拷一份的话，
 * 下次改主题算法只会改到其中一份，两个窗口一深一浅没有任何报错。
 */

export type AntdLocale = typeof zhCN

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

export function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}

/** 主题双输出：CSS 变量（同步执行，避免闪烁）+ antd ThemeConfig */
export function useAppTheme(settings: AppSettings | null): {
  mode: 'dark' | 'light'
  antdTheme: ThemeConfig
} {
  const systemDark = useSystemDark()
  const mode: 'dark' | 'light' = useMemo(() => {
    if (!settings) return 'dark'
    return settings.themeMode === 'system' ? (systemDark ? 'dark' : 'light') : settings.themeMode
  }, [settings, systemDark])
  const accent = settings?.accent ?? '#1677ff'
  const reduceTransparency = settings?.reduceTransparency ?? false
  const platformProfile = useMemo(() => resolvePlatformUiProfile(), [])
  useMemo(
    () => applyCssVars(mode, accent, reduceTransparency, platformProfile),
    [mode, accent, reduceTransparency, platformProfile]
  )
  const antdTheme = useMemo(
    () => buildAntdTheme(mode, accent, platformProfile),
    [mode, accent, platformProfile]
  )
  return { mode, antdTheme }
}

/**
 * 活动语言：en/zh 已内联可即时切；其余先向主进程取回语言包（i18n + antd）再切。
 * langReady 门控首屏，避免懒加载语言在包到位前先闪一屏英文。
 */
export function useAppLanguage(settings: AppSettings | null): {
  antdLocale: AntdLocale
  langReady: boolean
} {
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
  return { antdLocale, langReady }
}

/** 界面缩放：改根字号 + zoom（xterm/CodeMirror 都会随容器自适应） */
export function useUiZoom(settings: AppSettings | null): void {
  useEffect(() => {
    const zoom = (settings?.uiZoom ?? 100) / 100
    document.documentElement.style.setProperty('zoom', String(zoom))
  }, [settings?.uiZoom])
}
