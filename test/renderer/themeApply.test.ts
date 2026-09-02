// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { applyCssVars, buildAntdTheme } from '../../src/renderer/src/themes/applyTheme'

afterEach(() => {
  const root = document.documentElement
  root.removeAttribute('data-theme')
  root.removeAttribute('data-reduce-transparency')
  for (const property of [
    '--ofs-glass-surface',
    '--ofs-glass-surface-strong',
    '--ofs-solid-surface',
    '--ofs-glass-border',
    '--ofs-shell-surface',
    '--ofs-shell-surface-strong',
    '--ofs-shell-border'
  ]) {
    root.style.removeProperty(property)
  }
})

describe('applyCssVars', () => {
  it('公开玻璃 token，并在减少透明效果时切换为实体表面', () => {
    const theme = applyCssVars('dark', '#1677ff', true)
    const root = document.documentElement

    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.reduceTransparency).toBe('true')
    expect(root.style.getPropertyValue('--ofs-glass-surface')).toBe(theme.ui.glassSurface)
    expect(root.style.getPropertyValue('--ofs-shell-surface')).toBe(theme.ui.solidSurface)
    expect(root.style.getPropertyValue('--ofs-shell-border')).toBe(theme.ui.border)
  })

  it('Ant Design 圆角 token 固定为 4 / 6 / 8px', () => {
    const theme = buildAntdTheme('light', '#1677ff')
    expect(theme.token?.borderRadiusSM).toBe(4)
    expect(theme.token?.borderRadius).toBe(6)
    expect(theme.token?.borderRadiusLG).toBe(8)
  })
})
