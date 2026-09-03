import { theme as antdTheme, type ThemeConfig } from 'antd'
import { themes } from './palettes'
import type { OfsTheme } from './types'
import { resolvePlatformUiProfile, resolvePlatformUiTokens } from '@/ui/platform'
import type { PlatformUiProfile } from '@/ui/platform'

/**
 * 主题单一事实来源（TS token）→ 双输出：
 *  ① :root 上的 --ofs-* CSS 变量 + data-theme 属性（自绘组件用）
 *  ② antd ThemeConfig（组件库用）
 */
export function applyCssVars(
  mode: 'dark' | 'light',
  accent: string,
  reduceTransparency = false,
  platformProfile?: PlatformUiProfile
): OfsTheme {
  const t = themes[mode]
  const root = document.documentElement
  const profile = platformProfile ?? resolvePlatformUiProfile()
  const platformTokens = resolvePlatformUiTokens(profile)
  const glassEnabled = platformTokens.supportsGlass && !reduceTransparency
  root.dataset.theme = mode
  root.dataset.reduceTransparency = String(reduceTransparency)
  root.dataset.platformUi = profile
  root.dataset.platformGlass = String(glassEnabled)
  const vars: Record<string, string> = {
    '--ofs-bg-base': t.ui.bgBase,
    '--ofs-bg-panel': t.ui.bgPanel,
    '--ofs-bg-elevated': t.ui.bgElevated,
    '--ofs-bg-hover': t.ui.bgHover,
    '--ofs-bg-active': t.ui.bgActive,
    '--ofs-glass-surface': t.ui.glassSurface,
    '--ofs-glass-surface-strong': t.ui.glassSurfaceStrong,
    '--ofs-solid-surface': t.ui.solidSurface,
    '--ofs-glass-border': t.ui.glassBorder,
    '--ofs-shell-surface': glassEnabled ? t.ui.glassSurface : t.ui.solidSurface,
    '--ofs-shell-surface-strong': glassEnabled ? t.ui.glassSurfaceStrong : t.ui.solidSurface,
    '--ofs-shell-border': glassEnabled ? t.ui.glassBorder : t.ui.border,
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
    '--ofs-shadow-modal': t.ui.shadowModal,
    '--ofs-platform-radius-s': `${platformTokens.radius.small}px`,
    '--ofs-platform-radius-m': `${platformTokens.radius.medium}px`,
    '--ofs-platform-radius-l': `${platformTokens.radius.large}px`,
    '--ofs-platform-shell-surface': platformTokens.shellSurface,
    '--ofs-platform-workspace-surface': platformTokens.workspaceSurface,
    '--ofs-platform-border': platformTokens.border,
    '--ofs-platform-focus-ring': platformTokens.focusRing,
    '--ofs-platform-font-family': platformTokens.fontFamily,
    '--ofs-platform-density': platformTokens.density
  }
  // 语法色与编辑器容器色：走同一条 CSS 变量出口，于是 CodeMirror 的主题里
  // 写的全是 var(--ofs-syn-*) / var(--ofs-ed-*)，切主题时不用重建任何 EditorView。
  // 键名由 TS 的字段名机械派生（camelCase → kebab-case），加一个色位不用同步改两处
  for (const [k, v] of Object.entries(t.syntax)) vars[`--ofs-syn-${kebab(k)}`] = v
  for (const [k, v] of Object.entries(t.editor)) vars[`--ofs-ed-${kebab(k)}`] = v
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  return t
}

const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

export function buildAntdTheme(
  mode: 'dark' | 'light',
  accent: string,
  platformProfile?: PlatformUiProfile
): ThemeConfig {
  const t = themes[mode]
  const platformTokens = resolvePlatformUiTokens(platformProfile ?? resolvePlatformUiProfile())
  return {
    cssVar: true,
    hashed: false,
    algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: accent,
      colorBgBase: t.ui.bgBase,
      colorBgLayout: t.ui.bgBase,
      colorBgContainer: t.ui.bgPanel,
      colorBgElevated: t.ui.bgElevated,
      colorBorder: t.ui.border,
      colorBorderSecondary: t.ui.border,
      colorText: t.ui.textPrimary,
      colorTextSecondary: t.ui.textSecondary,
      colorTextDisabled: t.ui.textDisabled,
      borderRadius: platformTokens.radius.medium,
      borderRadiusSM: platformTokens.radius.small,
      borderRadiusLG: platformTokens.radius.large,
      boxShadow: t.ui.shadowPanel,
      boxShadowSecondary: t.ui.shadowModal,
      controlHeight: 32,
      controlHeightSM: 24,
      controlHeightLG: 40,
      fontSize: 13,
      fontFamily: platformTokens.fontFamily
    }
  }
}
