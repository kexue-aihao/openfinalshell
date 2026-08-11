import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  channelPass,
  computeTranscript,
  confirmMac,
  createEcdhPair,
  derivePairKey,
  generatePairingCode,
  macEquals
} from '../../src/main/lansync/pairing'

/**
 * 配对密码学的性质测试。这里不测"加密强不强"（那是算法的事），
 * 测的是**结构性质**：两侧派生一致、任一成分变化即失效、双向证明不可回射 ——
 * 每一条都是协议安全性的一根柱子，断了不会报编译错，只会静默变弱。
 */

/** 摆一次完整配对：双方各持己方私钥 + 对方公钥，各自派生（异步 scrypt） */
async function pairBothSides(codeS: string, codeR: string) {
  const sender = createEcdhPair()
  const receiver = createEcdhPair()
  const salt = Buffer.alloc(16, 3)
  const transcript = computeTranscript(sender.publicDer, receiver.publicDer, salt, 'sess-1')
  const keyS = await derivePairKey({
    ownPrivate: sender.privateKey,
    peerPublicDer: receiver.publicDer,
    code: codeS,
    salt,
    transcript
  })
  const keyR = await derivePairKey({
    ownPrivate: receiver.privateKey,
    peerPublicDer: sender.publicDer,
    code: codeR,
    salt,
    transcript
  })
  return { keyS, keyR, transcript }
}

describe('配对密钥派生', () => {
  it('码一致时两侧各自派生出同一把密钥（ECDH + HKDF + scrypt 全链）', async () => {
    const { keyS, keyR } = await pairBothSides('483920', '483920')
    expect(keyS.equals(keyR)).toBe(true)
    expect(keyS.byteLength).toBe(32)
  })

  it('码错一位 → 两侧密钥不同 → 码证明验不过（错码在线猜测被这一条挡住）', async () => {
    const { keyS, keyR, transcript } = await pairBothSides('483920', '483921')
    expect(keyS.equals(keyR)).toBe(false)
    const proofFromSender = confirmMac(keyS, 'sender', transcript)
    const expectedByReceiver = confirmMac(keyR, 'sender', transcript)
    expect(macEquals(proofFromSender, expectedByReceiver)).toBe(false)
  })

  it('对方公钥不是 x25519 → 直接拒绝（网络来的什么都可能是）', async () => {
    const sender = createEcdhPair()
    const ed = generateKeyPairSync('ed25519')
    await expect(
      derivePairKey({
        ownPrivate: sender.privateKey,
        peerPublicDer: ed.publicKey.export({ type: 'spki', format: 'der' }),
        code: '000000',
        salt: Buffer.alloc(16),
        transcript: Buffer.alloc(32)
      })
    ).rejects.toThrow(/x25519/)
  })
})

describe('transcript', () => {
  const a = createEcdhPair().publicDer
  const b = createEcdhPair().publicDer
  const salt = Buffer.alloc(16, 9)

  it('任一成分变化 → transcript 变化（公钥/盐/会话号各换一样试一遍）', () => {
    const base = computeTranscript(a, b, salt, 'sess')
    expect(computeTranscript(b, a, salt, 'sess').equals(base)).toBe(false) // 两把公钥对调也不行
    expect(computeTranscript(a, b, Buffer.alloc(16, 8), 'sess').equals(base)).toBe(false)
    expect(computeTranscript(a, b, salt, 'sess2').equals(base)).toBe(false)
  })

  it('成分带长度框定：拼接相同但边界不同 → 哈希不同（裸拼接会在这里出歧义）', () => {
    const one = computeTranscript(Buffer.from('aa'), Buffer.from('b'), salt, 'x')
    const other = computeTranscript(Buffer.from('a'), Buffer.from('ab'), salt, 'x')
    expect(one.equals(other)).toBe(false)
  })
})

describe('码证明', () => {
  it('两个方向的 MAC 不同 —— confirm-s 原样回射充当 confirm-r 必然验不过', () => {
    const key = Buffer.alloc(32, 5)
    const transcript = Buffer.alloc(32, 6)
    expect(macEquals(confirmMac(key, 'sender', transcript), confirmMac(key, 'receiver', transcript))).toBe(false)
  })

  it('macEquals：等值 true、异值 false、长度不等 false（timingSafeEqual 要求等长）', () => {
    const m = Buffer.alloc(32, 1)
    expect(macEquals(m, Buffer.alloc(32, 1))).toBe(true)
    expect(macEquals(m, Buffer.alloc(32, 2))).toBe(false)
    expect(macEquals(m, Buffer.alloc(16, 1))).toBe(false)
  })
})

describe('配对码与通道口令', () => {
  it('配对码恒 6 位数字（含前导零）', () => {
    for (let i = 0; i < 200; i++) expect(generatePairingCode()).toMatch(/^\d{6}$/)
  })

  it('channelPass 是 43 字符 base64url（32 字节密钥，无填充）', () => {
    const pass = channelPass(Buffer.alloc(32, 7))
    expect(pass).toHaveLength(43)
    expect(pass).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
