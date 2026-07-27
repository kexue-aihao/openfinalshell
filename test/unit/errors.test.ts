import { describe, expect, it } from 'vitest'
import { channelOpenError, friendlySshError } from '../../src/main/ssh/errors'
import { read, stripComments } from '../sourceGuard'

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

describe('channelOpenError', () => {
  // ssh2 ^1.17 对被拒的通道给的原话（fixture 用 reject() 不带描述时，冒号后面是空的）
  it.each([
    '(SSH) Channel open failure: open failed',
    '(SSH) Channel open failure: ',
    '(SSH) Channel open failure: administratively prohibited'
  ])('把 %s 翻成"通道用满"', (raw) => {
    const msg = channelOpenError(new Error(raw))
    expect(msg).toContain('MaxSessions')
    expect(msg).toContain('关闭部分终端')
    // 原话不能夹带出去：它对用户没有信息量，还会把人往"服务器坏了"的方向带
    expect(msg).not.toMatch(/open fail(ure|ed)/i)
  })

  it('不是通道问题时退回 friendlySshError，不吞掉别的判断', () => {
    expect(channelOpenError(new Error('All configured authentication methods failed'))).toContain(
      '认证失败'
    )
    expect(channelOpenError(new Error('something odd'))).toBe('something odd')
  })
})

/**
 * 每个开 session 通道的地方都必须用 channelOpenError，不能用 friendlySshError。
 *
 * 为什么要一条源码护栏：behavioral 用例（test/integration/maxSessions.test.ts）能覆盖
 * openShell / openMonitorChannel / browseSftpSession 三处，但 **acquireTransferSftp
 * 覆盖不到** —— 它开在第二条 TCP 连接上，而 SFTP 子系统是那条连接上的第一个通道，
 * 没有办法在它之前把那条连接的通道占满。这条护栏就是那一处唯一的看守，
 * 顺带管住"以后新加一个开通道的地方又选错映射函数"。
 *
 * 判据是"调用点之后的一段窗口里出现 channelOpenError 且不出现 friendlySshError"。
 * 两条都要：只查"没有 friendlySshError"的话，窗口取小了就永远绿；
 * 加上"必须出现 channelOpenError"就证明窗口真的够到了那条 reject。
 */
describe('SshConnection 的通道错误映射', () => {
  const src = stripComments(read('src/main/ssh/SshConnection.ts'))
  const WINDOW = 420

  const sites = ['client.shell(', 'client.exec(', 'client.sftp(']
  const found: Array<{ call: string; at: number; window: string }> = []
  for (const call of sites) {
    let at = src.indexOf(call)
    while (at >= 0) {
      found.push({ call, at, window: src.slice(at, at + WINDOW) })
      at = src.indexOf(call, at + 1)
    }
  }

  // 反空转：调用点数量对不上就说明搜法失效（比如以后改成 this.client?.shell(）
  it('五个开通道的调用点都还在（1 shell + 2 exec + 2 sftp）', () => {
    expect(found.map((f) => f.call).sort()).toEqual([
      'client.exec(',
      'client.exec(',
      'client.sftp(',
      'client.sftp(',
      'client.shell('
    ])
  })

  it('每个调用点的失败分支都走 channelOpenError', () => {
    const bad = found.filter(
      (f) => !f.window.includes('channelOpenError(') || f.window.includes('friendlySshError(')
    )
    expect(
      bad.map((f) => `${f.call}@${f.at}`),
      '这些开通道的地方没用 channelOpenError（通道用满时会把 ssh2 原话透给用户）'
    ).toEqual([])
  })
})
