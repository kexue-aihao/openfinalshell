/**
 * vitest 用的 electron 桩：让 main 进程模块可在 Node 下集成测试。
 * safeStorage 用固定密钥的 AES-256-GCM 模拟（真实 DPAPI 无法在测试环境用）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'ofs-test-userdata-'))
const KEY = Buffer.alloc(32, 7)

export const app = {
  getPath: (name: string): string => (name === 'userData' ? userData : userData),
  getVersion: (): string => '0.0.0-test',
  on: (): void => {},
  whenReady: async (): Promise<void> => {},
  requestSingleInstanceLock: (): boolean => true,
  quit: (): void => {},
  disableHardwareAcceleration: (): void => {}
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  getSelectedStorageBackend: (): 'gnome_libsecret' => 'gnome_libsecret',
  encryptString: (plain: string): Buffer => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', KEY, iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), enc])
  },
  decryptString: (buf: Buffer): string => {
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const decipher = createDecipheriv('aes-256-gcm', KEY, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
  }
}

export const ipcMain = {
  handle: (): void => {},
  on: (): void => {},
  removeHandler: (): void => {}
}

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  }),
  showSaveDialog: async (): Promise<{ canceled: boolean }> => ({ canceled: true })
}

export const shell = { openExternal: async (): Promise<void> => {}, showItemInFolder: (): void => {} }
export const nativeTheme = { shouldUseDarkColors: true, on: (): void => {} }
export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
}
export const testUserDataDir = userData
