import type { OfsTheme } from './types'

export const darkTheme: OfsTheme = {
  id: 'dark',
  ui: {
    bgBase: '#16181d',
    bgPanel: '#1d2026',
    bgElevated: '#242830',
    bgHover: 'rgba(255,255,255,.06)',
    bgActive: 'rgba(255,255,255,.10)',
    border: '#2c313a',
    borderStrong: '#3a404b',
    textPrimary: '#e6e8eb',
    textSecondary: '#9aa1ab',
    textDisabled: '#5c636e',
    success: '#52c41a',
    warning: '#faad14',
    error: '#f5222d',
    shadowPanel: '0 2px 8px rgba(0,0,0,.35)',
    shadowModal: '0 8px 32px rgba(0,0,0,.5)'
  },
  terminalThemeId: 'one-dark'
}

export const lightTheme: OfsTheme = {
  id: 'light',
  ui: {
    bgBase: '#f5f6f8',
    bgPanel: '#ffffff',
    bgElevated: '#ffffff',
    bgHover: 'rgba(0,0,0,.04)',
    bgActive: 'rgba(0,0,0,.08)',
    border: '#e4e7ec',
    borderStrong: '#cfd4dc',
    textPrimary: '#1f2329',
    textSecondary: '#5c636e',
    textDisabled: '#a0a6b0',
    success: '#52c41a',
    warning: '#faad14',
    error: '#f5222d',
    shadowPanel: '0 2px 8px rgba(0,0,0,.08)',
    shadowModal: '0 8px 32px rgba(0,0,0,.16)'
  },
  terminalThemeId: 'github-light'
}

export const themes = { dark: darkTheme, light: lightTheme } as const
