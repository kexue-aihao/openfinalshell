import { describe, expect, it } from 'vitest'
import { findRelocatedKeyPath } from '../../src/main/ssh/auth'

const FINGERPRINT = 'b7f06468dced375ec726a327f16fd99199f28485fd5338aa0c882dcdada6f078'

describe('私钥盘符重绑定', () => {
  it('只接受其它盘符上指纹一致的同一路径文件', async () => {
    const reads = new Map<string, Buffer>([
      ['D:\\keys\\id_ed25519', Buffer.from('wrong-key')],
      ['E:\\keys\\id_ed25519', Buffer.from('same-key')]
    ])
    const found = await findRelocatedKeyPath('H:\\keys\\id_ed25519', FINGERPRINT, {
      platform: 'win32',
      drives: ['D', 'E'],
      read: async (path) => {
        const bytes = reads.get(path)
        if (!bytes) throw new Error('missing')
        return bytes
      }
    })
    expect(found?.path).toBe('E:\\keys\\id_ed25519')
    expect(found?.bytes).toEqual(Buffer.from('same-key'))
  })

  it('没有指纹时不猜测其它盘符', async () => {
    const found = await findRelocatedKeyPath('H:\\keys\\id_ed25519', undefined, {
      platform: 'win32',
      drives: ['E'],
      read: async () => Buffer.from('same-key')
    })
    expect(found).toBeUndefined()
  })
})
