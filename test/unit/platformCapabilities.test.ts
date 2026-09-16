import { describe, expect, it } from 'vitest'
import { RDP_FEATURES } from '../../src/shared/platformCapabilities'
import { resolveRdpCapabilities } from '../../src/main/services/platformCapabilities'
import { resolveUpdateCapability } from '../../src/main/services/updateGate'

const full = Object.fromEntries(RDP_FEATURES.map(k => [k, true]))
const legacy = ['freerdp', 'framebuffer', 'input', 'resize', 'clipboard', 'audio']
describe('platform release admission', () => {
  it('does not infer native files or audio from a legacy hello', () => {
    const result = resolveRdpCapabilities({ platform: 'win32', legacy, clipboard: true, audio: true })
    expect(result.clipboardText.available).toBe(true)
    expect(result.clipboardFilesPaste).toEqual({ available: false, reason: 'legacy-worker' })
    expect(result.audioPlayback.available).toBe(false)
  })
  it('preserves Windows features with explicit backend support', () => {
    const result = resolveRdpCapabilities({ platform: 'win32', legacy, featureSupport: full, clipboard: true, audio: true })
    expect(Object.values(result).every(c => c.available)).toBe(true)
  })
  it('uses the native five-field feature report without losing core connection capabilities', () => {
    const featureSupport = { clipboardText: true, clipboardFilesUpload: true, clipboardFilesPaste: true, dragUpload: true, audioPlayback: false }
    const result = resolveRdpCapabilities({ platform: 'win32', legacy, featureSupport, clipboard: true, audio: true })
    expect(result.connection.available).toBe(true)
    expect(result.framebuffer.available).toBe(true)
    expect(result.input.available).toBe(true)
    expect(result.resize.available).toBe(true)
    expect(result.clipboardFilesPaste.available).toBe(true)
    expect(result.audioPlayback).toEqual({ available: false, reason: 'runtime-unavailable' })
  })
  it.each(['darwin', 'linux'] as const)('requires native file acceptance on %s', platform => {
    const result = resolveRdpCapabilities({ platform, legacy, featureSupport: full, clipboard: true, audio: true })
    expect(result.connection.available).toBe(true)
    expect(result.clipboardFilesUpload.reason).toBe('awaiting-acceptance')
    expect(result.audioPlayback.available).toBe(false)
  })
  it('requires both runtime support and configuration after admission', () => {
    const result = resolveRdpCapabilities({ platform: 'linux', legacy, featureSupport: {...full, audioPlayback:false}, clipboard: false, audio: true, acceptance: {clipboardFiles:true,audio:true} })
    expect(result.clipboardFilesPaste.reason).toBe('disabled')
    expect(result.audioPlayback.reason).toBe('runtime-unavailable')
  })
  it('uses manual updates on macOS without a signed published feed', () => {
    expect(resolveUpdateCapability({ platform:'darwin', packaged:true, portable:false })).toBe('manual')
    expect(resolveUpdateCapability({ platform:'darwin', packaged:true, portable:false, signedMacFeed:true })).toBe('install')
  })
})
