import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { SecretRef } from '@shared/types'
import { prepare } from './Database'
import { scopedLogger } from '../utils/logger'
import { t } from '../services/i18n'
import { secureStorageAvailable } from './secureStorage'

const log = scopedLogger('vault')

/**
 * 凭据保险库：safeStorage（Windows=DPAPI，绑定当前系统用户）。
 * 密文按行存在 secrets 表里；明文永不落库、也永不经 IPC 回传 renderer。
 * safeStorage 必须在 app ready 后使用 —— 本模块所有函数都只应在 ready 后调用。
 */
export const vault = {
  isAvailable(): boolean {
    return secureStorageAvailable()
  },

  /** 加密存入，返回引用 id；overwriteRef 传入时覆盖已有条目（沿用同一 ref） */
  putSecret(plaintext: string, overwriteRef?: SecretRef): SecretRef {
    if (!this.isAvailable()) {
      throw new Error(t('err.net.secureStoreUnavailable'))
    }
    const ref = overwriteRef ?? randomUUID()
    const cipher = safeStorage.encryptString(plaintext)
    prepare(
      'INSERT INTO secrets(ref, cipher) VALUES(?, ?) ON CONFLICT(ref) DO UPDATE SET cipher = ?'
    ).run(ref, cipher, cipher)
    return ref
  },

  /** 密钥库不可用时不保存，调用方仍可落实体并在使用时重新询问。 */
  putSecretIfAvailable(plaintext: string, overwriteRef?: SecretRef): SecretRef | undefined {
    if (!this.isAvailable()) {
      // 用户输入了替代值但无法安全保存：旧值不能继续冒充保存成功的新值。
      this.deleteSecret(overwriteRef)
      return undefined
    }
    return this.putSecret(plaintext, overwriteRef)
  },

  /** 仅 main 内部调用 */
  getSecret(ref: SecretRef): string | null {
    const row = prepare('SELECT cipher FROM secrets WHERE ref = ?').get(ref) as
      | { cipher: Uint8Array }
      | undefined
    if (!row) return null
    try {
      return safeStorage.decryptString(Buffer.from(row.cipher))
    } catch (err) {
      // 换机/重装系统后 DPAPI 密文无法解开，属预期情况：返回 null 让上层改为询问
      log.error(`failed to decrypt secret ${ref}`, err)
      return null
    }
  },

  deleteSecret(ref: SecretRef | undefined): void {
    if (!ref) return
    prepare('DELETE FROM secrets WHERE ref = ?').run(ref)
  },

  /** 写入即落库，保留此方法只为兼容退出前的 flush 调用 */
  async flush(): Promise<void> {
    /* no-op */
  }
}
