import type { PlatformSignals, PlatformUiProfile } from './types'

/**
 * Resolve the renderer's visual language without touching Electron or Node.
 * An explicit signal object makes this function deterministic in unit tests;
 * when omitted, only browser navigator fields are read.
 */
export function resolvePlatformUiProfile(signals?: PlatformSignals): PlatformUiProfile {
  const source = signals ?? readNavigatorSignals()
  const platform = [source.userAgentData?.platform, source.platform, source.userAgent]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (/(windows|win32|win64|winnt)/.test(platform)) return 'windows-fluent'
  if (/(macintosh|mac os|macos|darwin|iphone|ipad)/.test(platform)) return 'macos-hig'
  return 'linux-neutral'
}

function readNavigatorSignals(): PlatformSignals {
  if (typeof navigator === 'undefined') return {}

  const navigatorWithHints = navigator as Navigator & {
    userAgentData?: { platform?: string }
  }
  return {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    userAgentData: navigatorWithHints.userAgentData
  }
}
