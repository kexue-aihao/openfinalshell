import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 主进程 i18n（services/i18n.ts）的 t()：按设置语言取译文、{{var}} 插值、
 * 缺键回退 en 再回退键名、未知语言回退 en。用既有键测（不依赖 err.* 是否已迁完）。
 */
const state = vi.hoisted(() => ({ lang: 'zh-CN' }))
vi.mock('../../src/main/services/settings', () => ({
  getSettings: () => ({ language: state.lang })
}))

import { t } from '../../src/main/services/i18n'

afterEach(() => {
  state.lang = 'zh-CN'
})

describe('main t()', () => {
  it('按活动语言取译文', () => {
    state.lang = 'zh-CN'
    expect(t('tab.closeConfirm', { title: 'X' })).toContain('关闭')
    state.lang = 'en-US'
    expect(t('tab.closeConfirm', { title: 'X' })).toContain('Close')
  })

  it('{{var}} 插值', () => {
    state.lang = 'en-US'
    expect(t('tab.closeConfirm', { title: 'srv-1' })).toContain('srv-1')
  })

  it('缺变量时保留占位符名（不静默变空）', () => {
    state.lang = 'en-US'
    expect(t('tab.closeConfirm')).toContain('{{title}}')
  })

  it('缺键回退键名本身（永不抛、永不 undefined）', () => {
    state.lang = 'en-US'
    expect(t('err.nonexistent.key')).toBe('err.nonexistent.key')
  })

  it('未知语言回退 en-US', () => {
    state.lang = 'xx-YY'
    expect(t('tab.closeConfirm', { title: 'X' })).toContain('Close')
  })
})
