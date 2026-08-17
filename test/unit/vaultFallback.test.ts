import { beforeEach, describe, expect, it, vi } from 'vitest'
import { safeStorage } from 'electron'
import { prepare } from '../../src/main/store/Database'
import { vault } from '../../src/main/store/Vault'

describe('Vault 无安全后端时替换凭据', () => {
  beforeEach(() => {
    prepare('DELETE FROM secrets').run()
  })

  it('丢弃新明文并删除旧引用，避免旧密码冒充替换成功', () => {
    const ref = vault.putSecret('old-secret')
    const spy = vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
    try {
      expect(vault.putSecretIfAvailable('new-secret', ref)).toBeUndefined()
      expect(vault.getSecret(ref)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})
