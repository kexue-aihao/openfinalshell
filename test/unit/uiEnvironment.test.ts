import { describe, expect, it } from 'vitest'
import { resolveUiEnvironment } from '../../src/shared/uiEnvironment'

describe('host-owned UI environment', () => {
  it.each([
    ['10.0.19045', 'windows-10', true, false],
    ['10.0.22000', 'windows-11', true, false],
    ['10.0.22621', 'windows-11', true, true],
    ['10.0.26100', 'windows-11', true, true],
    ['10.0.17763', 'windows-10', false, false],
    ['invalid', 'windows-10', false, false]
  ])('classifies %s independently of the browser or Mica', (version, profile, supported, micaEligible) => {
    expect(resolveUiEnvironment('win32', version, 'workstation')).toMatchObject({ profile, supported, micaEligible })
  })
  it.each(['server', 'unknown'] as const)('does not misclassify %s as Windows 11', product => {
    expect(resolveUiEnvironment('win32', '10.0.26100', product)).toMatchObject({ profile: 'windows-10', supported: false, micaEligible: false })
  })
  it('keeps macOS and Linux profiles independent', () => {
    expect(resolveUiEnvironment('darwin', '24.0.0').profile).toBe('macos-hig')
    expect(resolveUiEnvironment('linux', '6.12.0').profile).toBe('linux-neutral')
  })
})
