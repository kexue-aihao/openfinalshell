// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { applyCssVars, buildAntdTheme } from '../../src/renderer/src/themes/applyTheme'
import { contrastRatio } from '../../src/renderer/src/themes/color'
import { PRESET_COLORS } from '../../src/shared/constants'
import { themes } from '../../src/renderer/src/themes/palettes'
import { resolveUiTheme } from '../../src/renderer/src/themes/windows'

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
  for (const mode of ['dark', 'light'] as const) {
    for (const profile of ['windows-11', 'macos-hig', 'linux-neutral'] as const) {
      it(`${profile} / ${mode}: all saved accent choices remain readable on every UI surface`, () => {
        const ui = resolveUiTheme(mode, profile).ui
        const surfaces = [ui.bgBase, ui.bgPanel, ui.bgElevated, ui.bgRaised, ui.bgInset]
        for (const seed of PRESET_COLORS) {
          applyCssVars(mode, seed, false, profile)
          const css = document.documentElement.style
          const color = css.getPropertyValue('--ofs-accent')
          expect(css.getPropertyValue('--ofs-accent-seed')).toBe(seed)
          expect(buildAntdTheme(mode, seed, profile).token?.colorPrimary).toBe(color)
          for (const surface of surfaces) {
            for (const text of [ui.textPrimary, ui.textSecondary, ui.textSubtle, color, ui.success, ui.warning, ui.error]) {
              expect(contrastRatio(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
            }
            expect(contrastRatio(ui.borderStrong, surface)).toBeGreaterThanOrEqual(3)
          }
          expect(contrastRatio(color, css.getPropertyValue('--ofs-on-accent'))).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
  }

  it('switching window themes preserves editor syntax palettes and opaque fallbacks', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const profile of ['windows-11', 'macos-hig', 'linux-neutral'] as const) {
        applyCssVars(mode, '#faad14', true, profile)
        const css = document.documentElement.style
        expect(css.getPropertyValue('--ofs-shell-surface')).toBe(resolveUiTheme(mode, profile).ui.solidSurface)
        expect(css.getPropertyValue('--ofs-syn-keyword')).toBe(themes[mode].syntax.keyword)
        expect(css.getPropertyValue('--ofs-ed-bg')).toBe(themes[mode].editor.bg)
      }
    }
  })
  it('公开玻璃 token，并在减少透明效果时切换为实体表面', () => {
    const theme = applyCssVars('dark', '#1677ff', true)
    const root = document.documentElement

    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.reduceTransparency).toBe('true')
    expect(root.style.getPropertyValue('--ofs-glass-surface')).toBe(theme.ui.glassSurface)
    expect(root.style.getPropertyValue('--ofs-shell-surface')).toBe(theme.ui.solidSurface)
    expect(root.style.getPropertyValue('--ofs-shell-border')).toBe(theme.ui.border)
  })

  it('Ant Design 圆角 token 随平台输出', () => {
    const theme = buildAntdTheme('light', '#1677ff', 'linux-neutral')
    expect(theme.token?.borderRadiusSM).toBe(4)
    expect(theme.token?.borderRadius).toBe(6)
    expect(theme.token?.borderRadiusLG).toBe(8)
    const windows = buildAntdTheme('light', '#1677ff', 'windows-11')
    expect(windows.token?.borderRadiusSM).toBe(4)
    expect(windows.token?.borderRadius).toBe(4)
    expect(windows.token?.borderRadiusLG).toBe(8)
  })
})
