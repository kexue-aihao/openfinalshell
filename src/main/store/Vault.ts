import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { SecretRef } from '@shared/types'
import { JsonFileStore } from './ConfigStore'
import { configFile } from './paths'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('vault')

interface VaultFile {
  version: number
  /** secretId → base64(safeStorage.encryptString(明文)) */
  entries: Record<string, string>
}

/**
 * 凭据保险库：safeStorage（Windows=DPAPI，绑定当前系统用户）。
 * getSecret 只允许 main 内部调用，明文永不经 IPC 回传 renderer。
 * safeStorage 必须在 app ready 后使用 —— 本模块所有函数都只应在 ready 后调用。
 */
let store: JsonFileStore<VaultFile> | null = null

function vaultStore(): JsonFileStore<VaultFile> {
  if (!store) {
    store = new JsonFileStore<VaultFile>(configFile.vault(), () => ({ version: 1, entries: {} }))
  }
  return store
}

export const vault = {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  },

  /** 加密存入，返回引用 id；overwriteRef 传入时覆盖已有条目（沿用同一 ref） */
  putSecret(plaintext: string, overwriteRef?: SecretRef): SecretRef {
    if (!this.isAvailable()) {
      throw new Error('本机无法安全保存密码（safeStorage 不可用），请改为每次连接时输入')
    }
    const ref = overwriteRef ?? randomUUID()
    const cipher = safeStorage.encryptString(plaintext).toString('base64')
    vaultStore().update((d) => {
      d.entries[ref] = cipher
    })
    return ref
  },

  /** 仅 main 内部调用 */
  getSecret(ref: SecretRef): string | null {
    const cipher = vaultStore().data.entries[ref]
    if (!cipher) return null
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    } catch (err) {
      log.error(`failed to decrypt secret ${ref}`, err)
      return null
    }
  },

  deleteSecret(ref: SecretRef | undefined): void {
    if (!ref) return
    vaultStore().update((d) => {
      delete d.entries[ref]
    })
  },

  async flush(): Promise<void> {
    await vaultStore().flush()
  }
}
