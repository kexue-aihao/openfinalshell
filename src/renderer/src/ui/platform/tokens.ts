import type { PlatformUiProfile, PlatformUiTokens } from './types'

const BASE_SURFACE = 'var(--ofs-shell-surface)'
const BASE_WORKSPACE = 'var(--ofs-solid-surface)'
const BASE_BORDER = 'var(--ofs-shell-border)'
const BASE_FOCUS = 'var(--ofs-accent)'
const SYSTEM_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Yu Gothic UI", "Meiryo", "Malgun Gothic", sans-serif'
// Linux distributions do not ship Segoe UI.  Prefer the browser/system UI
// face first, then the broadly available Noto families before falling back to
// DejaVu.  Keeping this stack here (rather than in individual components)
// makes Chromium's X11 and Wayland renderers use the same metrics.
const LINUX_SYSTEM_FONT =
  'system-ui, "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK TC", "DejaVu Sans", sans-serif'

const PLATFORM_TOKENS: Record<PlatformUiProfile, PlatformUiTokens> = {
  'windows-fluent': {
    radius: { small: 4, medium: 6, large: 8 },
    shellSurface: BASE_SURFACE,
    workspaceSurface: BASE_WORKSPACE,
    border: BASE_BORDER,
    focusRing: BASE_FOCUS,
    fontFamily: SYSTEM_FONT,
    density: 'comfortable',
    supportsGlass: true
  },
  'macos-hig': {
    radius: { small: 5, medium: 7, large: 10 },
    shellSurface: BASE_SURFACE,
    workspaceSurface: BASE_WORKSPACE,
    border: BASE_BORDER,
    focusRing: BASE_FOCUS,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif',
    density: 'comfortable',
    supportsGlass: true
  },
  'linux-neutral': {
    radius: { small: 4, medium: 6, large: 8 },
    shellSurface: BASE_SURFACE,
    workspaceSurface: BASE_WORKSPACE,
    border: BASE_BORDER,
    focusRing: BASE_FOCUS,
    fontFamily: LINUX_SYSTEM_FONT,
    density: 'compact',
    supportsGlass: false
  }
}

/**
 * Return a defensive copy so callers can add derived values without mutating
 * the shared profile definitions. Unknown values intentionally use the Linux
 * neutral profile as the safest opaque fallback.
 */
export function resolvePlatformUiTokens(profile?: string): PlatformUiTokens {
  const key: PlatformUiProfile = isPlatformUiProfile(profile) ? profile : 'linux-neutral'
  const tokens = PLATFORM_TOKENS[key]
  return {
    ...tokens,
    radius: { ...tokens.radius }
  }
}

function isPlatformUiProfile(value: string | undefined): value is PlatformUiProfile {
  return value === 'windows-fluent' || value === 'macos-hig' || value === 'linux-neutral'
}
