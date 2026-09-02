/**
 * Windows 11 22H2 is the first release Electron supports for system-drawn
 * background materials. Keep this independent of Electron so it can be
 * tested without a running desktop runtime.
 */
const WINDOWS_11_22H2_BUILD = 22621

export type WindowBackgroundMaterial = 'mica' | 'none'

export interface WindowMaterialInput {
  platform: string
  systemVersion: string
  reduceTransparency: boolean
}

/**
 * Mica already supplies the system-drawn background behind the non-client area.
 * Keeping the Window Controls Overlay transparent is what lets that material be
 * visible while retaining native caption buttons and Snap Layouts.
 */
export function resolveWindowControlsOverlayColor(
  material: WindowBackgroundMaterial,
  opaqueFallback: string
): string {
  return material === 'mica' ? 'transparent' : opaqueFallback
}

interface WindowMaterialTarget {
  setBackgroundMaterial?: (material: WindowBackgroundMaterial) => void
}

function getWindowsBuild(systemVersion: string): number | null {
  const parts = systemVersion.trim().split('.')
  if (parts.length < 3 || parts.some((part) => !/^\d+$/.test(part))) return null

  const build = Number(parts[2])
  return Number.isSafeInteger(build) ? build : null
}

/**
 * Mica is supported only by Windows 11 22H2+ (build 22621). All other
 * platforms and versions use an opaque window background.
 */
export function resolveWindowBackgroundMaterial({
  platform,
  systemVersion,
  reduceTransparency
}: WindowMaterialInput): WindowBackgroundMaterial {
  if (reduceTransparency || platform !== 'win32') return 'none'

  const build = getWindowsBuild(systemVersion)
  return build !== null && build >= WINDOWS_11_22H2_BUILD ? 'mica' : 'none'
}

/**
 * Older Electron builds and unsupported Windows configurations can reject the
 * material API at runtime. A material is cosmetic, so failure must never stop
 * the window from opening or applying other chrome settings.
 */
export function applyWindowBackgroundMaterial(
  target: WindowMaterialTarget,
  material: WindowBackgroundMaterial
): WindowBackgroundMaterial {
  if (!target.setBackgroundMaterial) return 'none'

  try {
    target.setBackgroundMaterial(material)
    return material
  } catch {
    if (material === 'mica') {
      try {
        target.setBackgroundMaterial('none')
      } catch {
        // There is no further recovery required for a cosmetic effect.
      }
    }
    return 'none'
  }
}
