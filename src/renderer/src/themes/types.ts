export interface OfsTheme {
  id: 'dark' | 'light'
  ui: {
    bgBase: string
    bgPanel: string
    bgElevated: string
    bgHover: string
    bgActive: string
    border: string
    borderStrong: string
    textPrimary: string
    textSecondary: string
    textDisabled: string
    success: string
    warning: string
    error: string
    shadowPanel: string
    shadowModal: string
  }
  /** 该 UI 主题下 terminal.themeId === 'auto' 时使用的终端配色 */
  terminalThemeId: string
}
