/** Main-owned feature decisions. A backend being compiled is not release acceptance. */
export type CapabilityReason = 'available' | 'not-implemented' | 'awaiting-acceptance' | 'session-required' | 'worker-missing' | 'legacy-worker' | 'runtime-unavailable' | 'disabled' | 'manual-update'
export interface FeatureCapability { available: boolean; reason: CapabilityReason }
export const RDP_FEATURES = ['connection', 'framebuffer', 'input', 'resize', 'clipboardText', 'clipboardFilesUpload', 'clipboardFilesPaste', 'dragUpload', 'audioPlayback'] as const
export type RdpFeature = typeof RDP_FEATURES[number]
export type RdpFeatureSupport = Record<RdpFeature, boolean>
export type RdpCapabilities = Record<RdpFeature, FeatureCapability>
export interface PlatformCapabilities {
  multiInstance: FeatureCapability
  updateCheck: FeatureCapability
  updateInstall: FeatureCapability
  rdp: RdpCapabilities
}
export interface RdpCapabilityEvent { sessionId: string; generation: number; capabilities: RdpCapabilities }

export function unavailableRdp(reason: CapabilityReason): RdpCapabilities {
  return Object.fromEntries(RDP_FEATURES.map(key => [key, { available: false, reason }])) as RdpCapabilities
}
