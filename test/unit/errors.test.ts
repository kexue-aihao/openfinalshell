import { describe, expect, it } from 'vitest'
import { friendlySshError } from '../../src/main/ssh/errors'

describe('friendlySshError', () => {
  it('认证失败', () => {
    expect(friendlySshError(new Error('All configured authentication methods failed'))).toContain(
      '认证失败'
    )
  })

  it('算法协商失败带原文，便于排查', () => {
    const msg = friendlySshError(
      new Error('Handshake failed: no matching key exchange algorithm')
    )
    expect(msg).toContain('兼容老算法')
    expect(msg).toContain('no matching key exchange algorithm')
  })

  // 报错字符串以 ssh2 ^1.17 实测为准，见 test/unit/privateKeyFormats.test.ts
  it('私钥问题区分缺口令、口令错误与格式不支持', () => {
    // 缺口令优先于格式判断（ssh2 的原文里带 OpenSSH 字样）
    expect(
      friendlySshError(
        new Error('Cannot parse privateKey: Encrypted private OpenSSH key detected, but no passphrase given')
      )
    ).toBe('私钥已加密，请在连接配置中填写私钥口令')

    // 口令错误的两种原文
    expect(
      friendlySshError(
        new Error('Cannot parse privateKey: OpenSSH key integrity check failed -- bad passphrase?')
      )
    ).toBe('私钥口令错误')
    expect(
      friendlySshError(new Error('Cannot parse privateKey: Malformed OpenSSH private key. Bad passphrase?'))
    ).toBe('私钥口令错误')

    // 格式不支持（PKCS#8、损坏文件、非私钥内容都是这条）必须给出转换命令
    const unsupported = friendlySshError(new Error('Cannot parse privateKey: Unsupported key format'))
    expect(unsupported).toContain('OpenSSH')
    expect(unsupported).toContain('ssh-keygen -p')
  })

  it('网络类错误', () => {
    expect(friendlySshError(new Error('connect ECONNREFUSED 127.0.0.1:22'))).toContain('端口未开放')
    expect(friendlySshError(new Error('Timed out while waiting for handshake'))).toContain('连接超时')
    expect(friendlySshError(new Error('getaddrinfo ENOTFOUND nope.invalid'))).toContain(
      '无法解析主机名'
    )
    expect(friendlySshError(new Error('read ECONNRESET'))).toContain('连接被重置')
  })

  it('未知错误原样透出，不吞信息', () => {
    expect(friendlySshError(new Error('something odd'))).toBe('something odd')
    expect(friendlySshError('plain string')).toBe('plain string')
  })
})
