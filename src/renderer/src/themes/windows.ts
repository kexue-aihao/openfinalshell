import type { PlatformUiProfile } from '@/ui/platform'
import { themes } from './palettes'
import type { OfsTheme } from './types'

// Fluent surfaces belong to the window shell. Terminal and editor palettes
// remain independent so syntax colors and saved terminal themes stay stable.
const windowsThemes: Record<'dark' | 'light', OfsTheme> = {
  dark: {
    ...themes.dark,
    ui: {
      ...themes.dark.ui,
      bgBase: '#202020', bgPanel: '#272727', bgElevated: '#2c2c2c',
      bgInset: '#1b1b1b', bgRaised: '#323232', solidSurface: '#272727',
      glassSurface: 'rgba(32,32,32,.78)', glassSurfaceStrong: 'rgba(44,44,44,.98)',
      border: '#3d3d3d', borderFaint: '#333333', borderStrong: '#929292',
      glassBorder: 'rgba(255,255,255,.08)',
      textPrimary: '#ffffff', textSecondary: '#d0d0d0', textSubtle: '#b5b5b5', textDisabled: '#858585',
      shadowPanel: '0 1px 2px rgba(0,0,0,.12)',
      shadowModal: '0 8px 24px rgba(0,0,0,.28), 0 24px 48px rgba(0,0,0,.16)'
    }
  },
  light: {
    ...themes.light,
    ui: {
      ...themes.light.ui,
      bgBase: '#f3f3f3', bgPanel: '#fbfbfb', bgElevated: '#ffffff',
      bgInset: '#eeeeee', bgRaised: '#ffffff', solidSurface: '#fbfbfb',
      glassSurface: 'rgba(243,243,243,.78)', glassSurfaceStrong: 'rgba(252,252,252,.98)',
      border: '#e0e0e0', borderFaint: '#eaeaea', borderStrong: '#858585',
      glassBorder: 'rgba(0,0,0,.07)',
      textPrimary: '#1a1a1a', textSecondary: '#484848', textSubtle: '#626262', textDisabled: '#929292',
      shadowPanel: '0 1px 2px rgba(0,0,0,.04)',
      shadowModal: '0 8px 24px rgba(0,0,0,.10), 0 24px 48px rgba(0,0,0,.06)'
    }
  }
}

export function resolveUiTheme(mode: 'dark' | 'light', profile: PlatformUiProfile): OfsTheme {
  if (profile === 'windows-10') {
    const base = windowsThemes[mode]
    return { ...base, ui: { ...base.ui,
      bgBase: mode === 'dark' ? '#1f1f1f' : '#f0f0f0',
      shadowPanel: 'none', shadowModal: mode === 'dark' ? '0 8px 24px #0006' : '0 8px 24px #0003'
    } }
  }
  return profile === 'windows-11' ? windowsThemes[mode] : themes[mode]
}
