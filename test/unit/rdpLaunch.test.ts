import { describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '@shared/types'
import { buildRdpContent } from '../../src/main/services/rdpLaunch'

const profile = (over: Partial<ConnectionProfile>): ConnectionProfile =>
  ({
    id: 'r1',
    name: 'win-box',
    protocol: 'rdp',
    groupId: null,
    host: '10.0.0.9',
    port: 3389,
    username: 'Administrator',
    auth: { method: 'password' },
    terminal: { charset: 'utf-8', termType: 'xterm' },
    options: {
      keepaliveInterval: 0,
      readyTimeout: 0,
      legacyAlgorithms: false,
      autoReconnect: false,
      monitorEnabled: false,
      compress: false
    },
    createdAt: 0,
    updatedAt: 0,
    ...over
  }) as ConnectionProfile

describe('buildRdpContent', () => {
  it('写入 host:port 与用户名，行尾是 CRLF', () => {
    const rdp = buildRdpContent(profile({}))
    expect(rdp).toContain('full address:s:10.0.0.9:3389')
    expect(rdp).toContain('username:s:Administrator')
    expect(rdp.endsWith('\r\n')).toBe(true)
    expect(rdp).toContain('\r\n') // 确实用 CRLF 而不是 LF
  })

  it('密码绝不进 .rdp —— 由系统凭据框接管（安全红线）', () => {
    // 无论 profile 里有什么，生成内容里都不该出现 password 指令或明文
    const rdp = buildRdpContent(
      profile({ auth: { method: 'password', passwordRef: 'ref-x' } } as Partial<ConnectionProfile>)
    )
    expect(rdp.toLowerCase()).not.toContain('password:')
    expect(rdp.toLowerCase()).not.toContain('clear password')
    // 让系统弹凭据框
    expect(rdp).toContain('prompt for credentials:i:1')
  })

  it('端口为 0/缺失时回落 3389', () => {
    expect(buildRdpContent(profile({ port: 0 }))).toContain('full address:s:10.0.0.9:3389')
  })

  it('用户名留空时不写 username 指令（让系统询问）', () => {
    expect(buildRdpContent(profile({ username: '' }))).not.toContain('username:s:')
  })

  it('host/用户名里的换行被剥掉，注入的 .rdp 指令无法自成一行', () => {
    // 若不剥换行，攻击者可在 host 里塞独立的 "drivestoredirect:s:*" 行打开驱动器重定向。
    // 剥掉后它被并进地址串（mstsc 当成无效主机名 → 连接失败），而非成为生效的指令行。
    const rdp = buildRdpContent(
      profile({ host: '10.0.0.9\r\ndrivestoredirect:s:*', username: 'a\nb' })
    )
    const lines = rdp.split('\r\n')
    // 关键性质：没有任何一行**是** drivestoredirect 指令
    expect(lines.some((l) => l.startsWith('drivestoredirect'))).toBe(false)
    // 注入串被折进地址行里
    expect(lines.find((l) => l.startsWith('full address'))).toContain('drivestoredirect:s:*')
    // 用户名里的换行也被剥掉，仍是单独一行
    expect(lines.filter((l) => l.startsWith('username:s:'))).toHaveLength(1)
    expect(lines.find((l) => l.startsWith('username:s:'))).toBe('username:s:ab')
  })
})
