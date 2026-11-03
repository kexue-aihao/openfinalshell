import { release } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { resolveUiEnvironment, type UiEnvironment, type WindowsProductType } from '@shared/uiEnvironment'
import { scopedLogger } from '../utils/logger'

let cached: UiEnvironment | undefined
export function getUiEnvironment(): UiEnvironment {
  if (cached) return cached
  let productType: WindowsProductType = 'unknown'
  if (process.platform === 'win32') {
    try {
      const result = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
        ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\ProductOptions', '/v', 'ProductType'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      const value = /ProductType\s+REG_SZ\s+(\S+)/i.exec(result)?.[1]
      productType = value === 'WinNT' ? 'workstation' : value === 'ServerNT' || value === 'LanmanNT' ? 'server' : 'unknown'
    } catch { /* Unknown product types deliberately keep opaque Windows 10 chrome. */ }
  }
  cached = resolveUiEnvironment(process.platform, release(), productType)
  if (!cached.supported) scopedLogger('uiEnvironment').warn(`Conservative UI fallback: ${cached.systemVersion}, ${productType}`)
  return cached
}
