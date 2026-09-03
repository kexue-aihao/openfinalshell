/**
 * Platform-specific visual language used by the desktop renderer.
 *
 * This type deliberately contains presentation concerns only.  It must not
 * depend on Electron or Node APIs so that it remains safe to evaluate in a
 * browser, a test DOM, or a future renderer host.
 */
export type PlatformUiProfile = 'windows-fluent' | 'macos-hig' | 'linux-neutral'

export interface PlatformUiTokens {
  radius: {
    small: number
    medium: number
    large: number
  }
  /** CSS color/value used by shell surfaces after theme variables are applied. */
  shellSurface: string
  /** CSS color/value used by high-throughput workspaces. */
  workspaceSurface: string
  border: string
  focusRing: string
  fontFamily: string
  density: 'compact' | 'comfortable'
  supportsGlass: boolean
}

export interface PlatformSignals {
  /** Equivalent to Navigator.platform, supplied explicitly for deterministic tests. */
  platform?: string
  /** Equivalent to Navigator.userAgent. */
  userAgent?: string
  /** Chromium's reduced User-Agent Client Hints surface. */
  userAgentData?: { platform?: string }
}
