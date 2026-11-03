import { describe, expect, it } from 'vitest'
import { resolvePlatformUiProfile } from '../../src/renderer/src/ui/platform/profile'
import { resolvePlatformUiTokens } from '../../src/renderer/src/ui/platform/tokens'

describe('resolvePlatformUiProfile', () => {
  it('maps Windows signals to the Fluent profile', () => {
    expect(
      resolvePlatformUiProfile({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })
    ).toBe('windows-10')
  })

  it('maps Apple signals to the HIG profile, including client hints', () => {
    expect(resolvePlatformUiProfile({ userAgentData: { platform: 'macOS' } })).toBe('macos-hig')
  })

  it('uses the neutral opaque profile for Linux and unknown environments', () => {
    expect(resolvePlatformUiProfile({ platform: 'Linux x86_64' })).toBe('linux-neutral')
    expect(resolvePlatformUiProfile({ platform: 'SomeBrowser' })).toBe('linux-neutral')
  })
})

describe('resolvePlatformUiTokens', () => {
  it('provides platform-specific density and glass support', () => {
    expect(resolvePlatformUiTokens('windows-11')).toMatchObject({
      density: 'comfortable',
      supportsGlass: true,
      radius: { small: 4, medium: 4, large: 8 }
    })
    expect(resolvePlatformUiTokens('linux-neutral')).toMatchObject({
      density: 'compact',
      supportsGlass: false
    })
    expect(resolvePlatformUiTokens('linux-neutral').fontFamily).toContain('system-ui')
    expect(resolvePlatformUiTokens('linux-neutral').fontFamily).toContain('Noto Sans')
    expect(resolvePlatformUiTokens('windows-11').fontFamily).toMatch(/^"Segoe UI Variable"/)
  })

  it('falls back to an opaque neutral profile for invalid values', () => {
    const tokens = resolvePlatformUiTokens('unsupported-profile')
    expect(tokens.supportsGlass).toBe(false)
    expect(tokens.workspaceSurface).toBe('var(--ofs-solid-surface)')
  })

  it('returns independent token objects', () => {
    const first = resolvePlatformUiTokens('windows-11')
    first.radius.small = 99
    expect(resolvePlatformUiTokens('windows-11').radius.small).toBe(4)
  })
})
