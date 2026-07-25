import { theme as antdTheme, type ThemeConfig } from 'antd'
import { themes } from './palettes'
import type { OfsTheme } from './types'

/**
 * 主题单一事实来源（TS token）→ 双输出：
 *  ① :root 上的 --ofs-* CSS 变量 + data-theme 属性（自绘组件用）
 *  ② antd ThemeConfig（组件库用）
 */
export function applyCssVars(mode: 'dark' | 'light', accent: string): OfsTheme {
  const t = themes[mode]
  const root = document.documentElement
  root.dataset.theme = mode
  const vars: Record<string, string> = {
    '--ofs-bg-base': t.ui.bgBase,
    '--ofs-bg-panel': t.ui.bgPanel,
    '--ofs-bg-elevated': t.ui.bgElevated,
    '--ofs-bg-hover': t.ui.bgHover,
    '--ofs-bg-active': t.ui.bgActive,
    '--ofs-border': t.ui.border,
    '--ofs-border-strong': t.ui.borderStrong,
    '--ofs-text-1': t.ui.textPrimary,
    '--ofs-text-2': t.ui.textSecondary,
    '--ofs-text-3': t.ui.textDisabled,
    '--ofs-accent': accent,
    '--ofs-success': t.ui.success,
    '--ofs-warning': t.ui.warning,
    '--ofs-error': t.ui.error,
    '--ofs-shadow-panel': t.ui.shadowPanel,
    '--ofs-shadow-modal': t.ui.shadowModal
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  return t
}

export function buildAntdTheme(mode: 'dark' | 'light', accent: string): ThemeConfig {
  const t = themes[mode]
  return {
    cssVar: true,
    hashed: false,
    algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: accent,
      colorBgContainer: t.ui.bgPanel,
      colorBgElevated: t.ui.bgElevated,
      colorBorder: t.ui.border,
      colorBorderSecondary: t.ui.border,
      borderRadius: 6,
      fontSize: 13,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
    }
  }
}
