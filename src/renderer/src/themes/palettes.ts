import type { OfsTheme } from './types'

/**
 * 两套 UI 主题的语法配色分别对齐 **One Dark**（深色）与 **GitHub Light**（浅色）——
 * 也就是这两个主题各自的 `terminalThemeId`。这样内置编辑器与它旁边的终端并排时
 * 是同一套色感，而不是两个各自好看、放一起打架的配色。
 *
 * 选中色与光标用 `color-mix(… var(--ofs-accent) …)` 跟着用户选的强调色走：
 * 8 种强调色都要能在这两个背景上读得清，所以混的是**透明度**而不是替换色相。
 */
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
  syntax: {
    comment: '#6b727f',
    keyword: '#c678dd',
    string: '#98c379',
    number: '#d19a66',
    constant: '#d19a66',
    property: '#e06c75',
    variable: '#e5c07b',
    function: '#61afef',
    type: '#e5c07b',
    operator: '#56b6c2',
    punctuation: '#9aa1ab',
    tag: '#e06c75',
    attribute: '#d19a66',
    invalid: '#ff6b6b',
    meta: '#56b6c2'
  },
  editor: {
    bg: '#16181d',
    fg: '#abb2bf',
    gutterBg: 'transparent',
    gutterFg: '#4b5263',
    gutterActiveFg: '#9aa1ab',
    activeLine: 'rgba(255,255,255,.035)',
    selection: 'color-mix(in srgb, var(--ofs-accent) 32%, transparent)',
    selectionMatch: 'color-mix(in srgb, var(--ofs-accent) 16%, transparent)',
    searchMatch: 'rgba(250,173,20,.28)',
    searchMatchActive: 'rgba(250,173,20,.55)',
    cursor: 'var(--ofs-accent)',
    foldPlaceholder: '#5c636e',
    specialChar: '#f5222d'
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
  syntax: {
    comment: '#6a737d',
    keyword: '#d73a49',
    string: '#032f62',
    number: '#005cc5',
    constant: '#005cc5',
    property: '#005cc5',
    variable: '#e36209',
    function: '#6f42c1',
    type: '#6f42c1',
    operator: '#d73a49',
    punctuation: '#57606a',
    tag: '#22863a',
    attribute: '#6f42c1',
    invalid: '#b31d28',
    meta: '#005cc5'
  },
  editor: {
    bg: '#ffffff',
    fg: '#24292e',
    gutterBg: 'transparent',
    gutterFg: '#b1b7c0',
    gutterActiveFg: '#57606a',
    activeLine: 'rgba(0,0,0,.028)',
    selection: 'color-mix(in srgb, var(--ofs-accent) 22%, transparent)',
    selectionMatch: 'color-mix(in srgb, var(--ofs-accent) 12%, transparent)',
    searchMatch: 'rgba(250,173,20,.36)',
    searchMatchActive: 'rgba(250,173,20,.7)',
    cursor: 'var(--ofs-accent)',
    foldPlaceholder: '#a0a6b0',
    specialChar: '#d1242f'
  },
  terminalThemeId: 'github-light'
}

export const themes = { dark: darkTheme, light: lightTheme } as const
