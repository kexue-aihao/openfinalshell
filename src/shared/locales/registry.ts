/**
 * 语言注册表 —— 所有“支持哪些语言”的枚举点的唯一来源。
 *
 * 加一门语言 = 这里加一条 + `src/shared/locales/<tag>.json` 加一份（键与 en-US 全等）。
 * 消费方：AppSettings.language 类型、设置里的语言下拉、App.tsx 的 antd locale 映射、
 * 主进程 i18n、checkI18n 校验器。中/英为人工权威版，其余为 AI 初翻待母语校对
 * （见各 json 的 `_meta.machineTranslated` 与 agent.md 的 i18n 规范段）。
 *
 * `antd` 是 `antd/locale/<name>` 的文件名；`bundled` 表示该语言包随渲染进程主 bundle
 * 静态打包（en/zh，保首屏无闪烁），其余语言运行时按需向主进程取回（IPC i18n:bundle），
 * 以免把 10 份语言包全塞进受字节预算约束的渲染 JS。
 */
export interface LocaleMeta {
  tag: string
  /** 该语言自称，语言下拉里显示（endonym，不翻译） */
  nativeName: string
  /** 英文名，仅用于代码/日志可读性 */
  englishName: string
  /** antd/locale/<antd> 的文件名 */
  antd: string
  dir: 'ltr' | 'rtl'
  /** 是否随渲染主 bundle 静态打包（否则运行时懒加载） */
  bundled: boolean
}

export const LOCALES = [
  { tag: 'zh-CN', nativeName: '简体中文', englishName: 'Chinese (Simplified)', antd: 'zh_CN', dir: 'ltr', bundled: true },
  { tag: 'zh-TW', nativeName: '繁體中文', englishName: 'Chinese (Traditional)', antd: 'zh_TW', dir: 'ltr', bundled: false },
  { tag: 'en-US', nativeName: 'English', englishName: 'English', antd: 'en_US', dir: 'ltr', bundled: true },
  { tag: 'ja-JP', nativeName: '日本語', englishName: 'Japanese', antd: 'ja_JP', dir: 'ltr', bundled: false },
  { tag: 'ko-KR', nativeName: '한국어', englishName: 'Korean', antd: 'ko_KR', dir: 'ltr', bundled: false },
  { tag: 'ru-RU', nativeName: 'Русский', englishName: 'Russian', antd: 'ru_RU', dir: 'ltr', bundled: false },
  { tag: 'es-ES', nativeName: 'Español', englishName: 'Spanish', antd: 'es_ES', dir: 'ltr', bundled: false },
  { tag: 'fr-FR', nativeName: 'Français', englishName: 'French', antd: 'fr_FR', dir: 'ltr', bundled: false },
  { tag: 'de-DE', nativeName: 'Deutsch', englishName: 'German', antd: 'de_DE', dir: 'ltr', bundled: false },
  { tag: 'pt-BR', nativeName: 'Português (Brasil)', englishName: 'Portuguese (Brazil)', antd: 'pt_BR', dir: 'ltr', bundled: false }
] as const

export type LocaleTag = (typeof LOCALES)[number]['tag']

export const LOCALE_TAGS: LocaleTag[] = LOCALES.map((l) => l.tag)

export const DEFAULT_LOCALE: LocaleTag = 'zh-CN'

export function localeMeta(tag: string): LocaleMeta {
  return (LOCALES.find((l) => l.tag === tag) ?? LOCALES[0]) as LocaleMeta
}
