import { RDP_FEATURES, unavailableRdp, type FeatureCapability, type RdpCapabilities, type RdpFeatureSupport } from '@shared/platformCapabilities'

export type DesktopPlatform = NodeJS.Platform
export const capability = (available: boolean, reason: FeatureCapability['reason']): FeatureCapability => ({ available, reason: available ? 'available' : reason })

/** New native functionality remains gated until the platform acceptance report is committed. */
export const PLATFORM_ACCEPTANCE = {
  win32: { multiInstance: true, clipboardFiles: true, audio: true },
  darwin: { multiInstance: false, clipboardFiles: false, audio: false },
  linux: { multiInstance: false, clipboardFiles: false, audio: false }
} as const

export function platformAcceptance(platform: DesktopPlatform = process.platform) {
  return PLATFORM_ACCEPTANCE[platform as keyof typeof PLATFORM_ACCEPTANCE] ?? { multiInstance: false, clipboardFiles: false, audio: false }
}

export function resolveRdpCapabilities(input: {
  platform: DesktopPlatform
  legacy: readonly string[]
  featureSupport?: unknown
  clipboard: boolean
  audio: boolean
  acceptance?: { clipboardFiles: boolean; audio: boolean }
}): RdpCapabilities {
  const result = unavailableRdp('not-implemented')
  const detail = input.featureSupport !== null && typeof input.featureSupport === 'object' && !Array.isArray(input.featureSupport)
    ? input.featureSupport as Partial<RdpFeatureSupport> : undefined
  const admission = input.acceptance ?? platformAcceptance(input.platform)
  for (const key of RDP_FEATURES) {
    const files = key === 'clipboardFilesUpload' || key === 'clipboardFilesPaste' || key === 'dragUpload'
    const legacyKey = key === 'connection' ? 'freerdp' : key === 'clipboardText' ? 'clipboard' : key
    const backend = detail && key in detail ? detail[key] === true : !files && key !== 'audioPlayback' && input.legacy.includes(legacyKey)
    const accepted = files ? admission.clipboardFiles : key === 'audioPlayback' ? admission.audio : true
    const enabled = files || key === 'clipboardText' ? input.clipboard : key === 'audioPlayback' ? input.audio : true
    result[key] = capability(backend && accepted && enabled,
      !enabled ? 'disabled' : !detail && (files || key === 'audioPlayback') ? 'legacy-worker' : !backend ? 'runtime-unavailable' : !accepted ? 'awaiting-acceptance' : 'available')
  }
  return result
}
