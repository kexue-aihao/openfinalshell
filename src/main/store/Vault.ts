import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { SecretRef } from '@shared/types'
import { prepare } from './Database'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('vault')

/**
 * 凭据保险库：safeStorage（Windows=DPAPI，绑定当前系统用户）。
 * 密文按行存在 secrets 表里；明文永不落库、也永不经 IPC 回传 renderer。
 * safeStorage 必须在 app ready 后使用 —— 本模块所有函数都只应在 ready 后调用。
 */
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
    const cipher = safeStorage.encryptString(plaintext)
    prepare(
      'INSERT INTO secrets(ref, cipher) VALUES(?, ?) ON CONFLICT(ref) DO UPDATE SET cipher = ?'
    ).run(ref, cipher, cipher)
    return ref
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
