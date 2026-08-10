import data from '@shared/locales/en-US.json'

/**
 * 兼容垫片。语言真正的唯一来源是 `src/shared/locales/en-US.json`（主/渲染共用）。
 * 这里只为老的按功能护栏测试保留 `{ translation: {...} }` 形状与可动态索引的类型
 * （测试里 `en.translation.<group>[k]`）。应用运行时不走这里 —— i18n/index.ts 直接读 json。
 */
const shim: { translation: Record<string, Record<string, unknown>> } = {
  translation: data as unknown as Record<string, Record<string, unknown>>
}
export default shim
