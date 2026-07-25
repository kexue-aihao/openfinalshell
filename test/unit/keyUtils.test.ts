import { describe, expect, it } from 'vitest'
import { fingerprintSha256, parseKeyType } from '../../src/main/ssh/keyUtils'

/** 构造 ssh wire 格式的 key blob：4 字节大端长度 + 算法名 + 载荷 */
function makeKeyBlob(algo: string, payload = 'payload'): Buffer {
  const name = Buffer.from(algo, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(name.length, 0)
  return Buffer.concat([len, name, Buffer.from(payload)])
}

describe('parseKeyType', () => {
  it('解析常见算法名', () => {
    expect(parseKeyType(makeKeyBlob('ssh-ed25519'))).toBe('ssh-ed25519')
    expect(parseKeyType(makeKeyBlob('ssh-rsa'))).toBe('ssh-rsa')
    expect(parseKeyType(makeKeyBlob('ecdsa-sha2-nistp256'))).toBe('ecdsa-sha2-nistp256')
  })

  it('畸形输入返回 unknown 而不抛异常', () => {
    expect(parseKeyType(Buffer.alloc(0))).toBe('unknown')
    expect(parseKeyType(Buffer.from([0, 0, 0]))).toBe('unknown')
    // 声明长度超出实际数据
    const bad = Buffer.alloc(8)
    bad.writeUInt32BE(999, 0)
    expect(parseKeyType(bad)).toBe('unknown')
    // 长度为 0
    expect(parseKeyType(Buffer.alloc(8))).toBe('unknown')
  })
})

describe('fingerprintSha256', () => {
  it('与 OpenSSH 风格一致：base64 且无尾部填充', () => {
    const fp = fingerprintSha256(Buffer.from('hello'))
    expect(fp).toBe('LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ')
    expect(fp).not.toMatch(/=$/)
  })

  it('不同输入产生不同指纹', () => {
    expect(fingerprintSha256(Buffer.from('a'))).not.toBe(fingerprintSha256(Buffer.from('b')))
  })
})
