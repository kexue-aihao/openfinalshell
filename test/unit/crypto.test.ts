import { beforeAll, describe, expect, it } from 'vitest'
import { safeStorage } from '../stubs/electron'

/**
 * 字段级 at-rest 加密原语。safeStorage 用桩（固定密钥 AES-GCM），
 * 因此这里跑的是真实的 encField/decField/tokenize 路径。
 */
const { database } = await import('../../src/main/store/Database')
const crypto = await import('../../src/main/store/crypto')

beforeAll(() => {
  database() // MDK 存在 meta 表里，需要先建库
})

describe('crypto：字段级加密原语', () => {
  it('encField → decField 往返；产出带 enc: 前缀且不含明文', () => {
    const plain = 'root@203.0.113.5 机密'
    const enc = crypto.encField(plain)
    expect(enc.startsWith('enc:1:')).toBe(true)
    expect(enc).not.toContain('203.0.113.5')
    expect(crypto.decField(enc)).toBe(plain)
  })

  it('每次加密 IV 随机：同明文两次密文不同，但都解得回', () => {
    const a = crypto.encField('same')
    const b = crypto.encField('same')
    expect(a).not.toBe(b)
    expect(crypto.decField(a)).toBe('same')
    expect(crypto.decField(b)).toBe('same')
  })

  it('decField 对非本模块密文原样透传（明文/降级/部分迁移都安全）', () => {
    expect(crypto.decField('{"host":"x"}')).toBe('{"host":"x"}')
    expect(crypto.decField('')).toBe('')
  })

  it('tokenize 决定论：同输入同 token、不同输入不同 token，且非明文', () => {
    const t1 = crypto.tokenize('a:22:ssh-ed25519')
    const t2 = crypto.tokenize('a:22:ssh-ed25519')
    const t3 = crypto.tokenize('b:22:ssh-ed25519')
    expect(t1).toBe(t2)
    expect(t1).not.toBe(t3)
    expect(t1).not.toContain('a:22')
    expect(t1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('safeStorage 不可用时降级为明文（不 brick），且带前缀的密文解不动会抛错', () => {
    const realEnc = crypto.encField('will-need-key')
    const orig = safeStorage.isEncryptionAvailable
    try {
      safeStorage.isEncryptionAvailable = (): boolean => false
      crypto._resetDataKeyCacheForTests()
      expect(crypto.isDataEncryptionAvailable()).toBe(false)
      // 加密不可用 → 原样返回明文，不带前缀
      expect(crypto.encField('plain')).toBe('plain')
      expect(crypto.tokenize('plain')).toBe('plain')
      // 但已经是密文的值此时解不开 → 抛专用错误（换机 key 丢失场景）
      expect(() => crypto.decField(realEnc)).toThrow()
    } finally {
      safeStorage.isEncryptionAvailable = orig
      crypto._resetDataKeyCacheForTests()
    }
    // 恢复后仍能解回（MDK 从 meta 里重新解出）
    expect(crypto.decField(realEnc)).toBe('will-need-key')
  })

  it('不缓存 null：safeStorage 从不可用变可用后自动重解析（否则会把整会话加密永久关掉）', () => {
    // 回归 F2：启动早期（app ready 前）isEncryptionAvailable 可能为 false，
    // 那一次调用绝不能把 null 粘住——ready 后必须能重解析成功。
    const orig = safeStorage.isEncryptionAvailable
    try {
      safeStorage.isEncryptionAvailable = (): boolean => false
      crypto._resetDataKeyCacheForTests()
      expect(crypto.isDataEncryptionAvailable()).toBe(false)
      // 恢复可用，但**不** reset 缓存 —— 模拟 app ready 后 safeStorage 才就绪
      safeStorage.isEncryptionAvailable = orig
      expect(crypto.isDataEncryptionAvailable()).toBe(true)
      const enc = crypto.encField('after-ready')
      expect(enc.startsWith('enc:1:')).toBe(true)
      expect(crypto.decField(enc)).toBe('after-ready')
    } finally {
      safeStorage.isEncryptionAvailable = orig
      crypto._resetDataKeyCacheForTests()
    }
  })
})
