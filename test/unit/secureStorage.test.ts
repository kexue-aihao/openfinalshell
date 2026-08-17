import { describe, expect, it } from 'vitest'
import { secureStorageAvailable } from '../../src/main/store/secureStorage'

describe('secureStorageAvailable', () => {
  it('不可加密时所有平台都不可用', () => {
    expect(secureStorageAvailable({ platform: 'win32', encryptionAvailable: false })).toBe(false)
    expect(secureStorageAvailable({ platform: 'linux', encryptionAvailable: false, backend: 'gnome_libsecret' })).toBe(false)
  })

  it('Windows 使用 Electron 的系统加密判断', () => {
    expect(secureStorageAvailable({ platform: 'win32', encryptionAvailable: true })).toBe(true)
  })

  it('Linux 拒绝 basic_text，接受 Secret Service 和 KWallet', () => {
    expect(secureStorageAvailable({ platform: 'linux', encryptionAvailable: true, backend: 'basic_text' })).toBe(false)
    expect(secureStorageAvailable({ platform: 'linux', encryptionAvailable: true, backend: 'unknown' })).toBe(false)
    expect(secureStorageAvailable({ platform: 'linux', encryptionAvailable: true, backend: 'gnome_libsecret' })).toBe(true)
    expect(secureStorageAvailable({ platform: 'linux', encryptionAvailable: true, backend: 'kwallet6' })).toBe(true)
  })
})
