import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from '@shared/locales/zh-CN.json'
import enUS from '@shared/locales/en-US.json'

/**
 * 语言包唯一来源是 src/shared/locales/*.json（主/渲染共用）。这里只把 en/zh 两份
 * 静态打包进渲染主 bundle（保首屏无闪烁、且已在字节预算内）；其余语言运行时经
 * `ensureBundle` 由 App 从主进程取回后注入 —— 10 份全打包会爆渲染 JS 预算。
 * fallback 用 en-US（对全球用户比中文更通用；键全等由 check:i18n 保证，回退很少触发）。
 */
void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS }
  },
  lng: 'zh-CN',
  fallbackLng: 'en-US',
  interpolation: { escapeValue: false },
  returnNull: false
})

const loaded = new Set<string>(['zh-CN', 'en-US'])

export function isBundleLoaded(tag: string): boolean {
  return loaded.has(tag)
}

/** 注入一份运行时取回的语言包（en/zh 已内联，重复注入会被忽略） */
export function ensureBundle(tag: string, translation: Record<string, unknown>): void {
  if (loaded.has(tag)) return
  i18n.addResourceBundle(tag, 'translation', translation, true, true)
  loaded.add(tag)
}

export default i18n
