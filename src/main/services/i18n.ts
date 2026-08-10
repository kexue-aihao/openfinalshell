import { LOCALE_TAGS, type LocaleTag } from '@shared/locales/registry'
import zhCN from '@shared/locales/zh-CN.json'
import zhTW from '@shared/locales/zh-TW.json'
import enUS from '@shared/locales/en-US.json'
import jaJP from '@shared/locales/ja-JP.json'
import koKR from '@shared/locales/ko-KR.json'
import ruRU from '@shared/locales/ru-RU.json'
import esES from '@shared/locales/es-ES.json'
import frFR from '@shared/locales/fr-FR.json'
import deDE from '@shared/locales/de-DE.json'
import ptBR from '@shared/locales/pt-BR.json'
import { getSettings } from './settings'

/**
 * 主进程 i18n。主进程没有 react-i18next，但用户可见的报错文案（约 150+ 条）也要随语言走，
 * 所以这里持有全部语言包（打进主 bundle，不受渲染字节预算约束），按 `getSettings().language`
 * 取活动语言翻译错误串；缺键回退 en-US 再回退 key 本身。同一份 json 也经 IPC `i18n:bundle`
 * 发给渲染进程，保证主/渲染用的是同一套翻译。
 */
type Bundle = Record<string, unknown>
const BUNDLES: Record<string, Bundle> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'en-US': enUS,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'ru-RU': ruRU,
  'es-ES': esES,
  'fr-FR': frFR,
  'de-DE': deDE,
  'pt-BR': ptBR
}

/** 语言包（供 IPC 发给渲染层）；未知 tag 回退 en-US */
export function getBundle(tag: string): Bundle {
  return BUNDLES[tag] ?? BUNDLES['en-US']
}

export function isSupportedLocale(tag: string): tag is LocaleTag {
  return (LOCALE_TAGS as string[]).includes(tag)
}

function lookup(bundle: Bundle, dotted: string): string | undefined {
  const v = dotted.split('.').reduce<unknown>((o, k) => {
    if (o && typeof o === 'object') return (o as Record<string, unknown>)[k]
    return undefined
  }, bundle)
  return typeof v === 'string' ? v : undefined
}

function interpolate(s: string, vars?: Record<string, unknown>): string {
  if (!vars) return s
  return s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    vars[k] === undefined || vars[k] === null ? `{{${k}}}` : String(vars[k])
  )
}

/**
 * 翻译一个键。活动语言取自设置；缺键回退 en-US，再回退键名本身（永不抛、永不返回 undefined）。
 * 用法与渲染层 t 对齐：`t('err.authFailed')`、`t('err.reconnectIn', { seconds: 3 })`。
 */
export function t(key: string, vars?: Record<string, unknown>): string {
  const lang = getSettings().language
  const active = BUNDLES[lang] ?? BUNDLES['en-US']
  const s = lookup(active, key) ?? lookup(BUNDLES['en-US'], key) ?? key
  return interpolate(s, vars)
}
