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

  it('私钥问题区分口令错误与格式不支持', () => {
    expect(friendlySshError(new Error('Cannot parse privateKey: bad passphrase?'))).toBe(
      '私钥口令错误'
    )
    expect(friendlySshError(new Error('Cannot parse privateKey: Unsupported key format'))).toContain(
      'PPK v3'
    )
    expect(
      friendlySshError(new Error('Encrypted private key detected, but no passphrase given'))
    ).toContain('请在连接配置中填写私钥口令')
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
