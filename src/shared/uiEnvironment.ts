/** Host facts are transient. They must never be imported from user settings. */
export type DesktopUiProfile = 'windows-10' | 'windows-11' | 'macos-hig' | 'linux-neutral'
export type WindowsProductType = 'workstation' | 'server' | 'unknown'
export interface UiEnvironment {
  platform: string
  systemVersion: string
  windowsBuild: number | null
  productType: WindowsProductType
  profile: DesktopUiProfile
  supported: boolean
  micaEligible: boolean
}

export function resolveUiEnvironment(platform: string, systemVersion: string, productType: WindowsProductType = 'unknown'): UiEnvironment {
  const parts = systemVersion.trim().split('.')
  const build = parts.length >= 3 && parts.every(p => /^\d+$/.test(p)) && Number.isSafeInteger(Number(parts[2]))
    ? Number(parts[2]) : null
  const desktop = platform === 'win32' && productType === 'workstation'
  const validWindows = desktop && parts[0] === '10' && build !== null && build >= 19045
  const profile: DesktopUiProfile = platform === 'win32'
    ? validWindows && build! >= 22000 ? 'windows-11' : 'windows-10'
    : platform === 'darwin' ? 'macos-hig' : 'linux-neutral'
  return {
    platform, systemVersion, windowsBuild: platform === 'win32' ? build : null, productType,
    profile, supported: platform !== 'win32' || validWindows,
    // Electron's native material API requires 22H2; OS style starts at 22000.
    micaEligible: profile === 'windows-11' && build! >= 22621
  }
}
