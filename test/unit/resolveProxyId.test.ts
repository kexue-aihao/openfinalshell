import { describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '@shared/types'
import { resolveProxyId } from '../../src/main/ssh/auth'

// 只测 resolveProxyId 这一段纯逻辑（不碰 Vault / getProxy / 网络）
const base = (over: Partial<ConnectionProfile>): ConnectionProfile =>
  ({
    id: 'p1',
    name: 't',
    groupId: null,
    host: 'h',
    port: 22,
    username: 'u',
    auth: { method: 'password' },
    terminal: { charset: 'utf-8', termType: 'xterm' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 15000,
      legacyAlgorithms: false,
      autoReconnect: false,
      monitorEnabled: false,
      compress: false
    },
    createdAt: 0,
    updatedAt: 0,
    ...over
  }) as ConnectionProfile

describe('resolveProxyId：代理归属三态', () => {
  it("follow：取全局默认（含 null=直连）", () => {
    expect(resolveProxyId(base({ proxyMode: 'follow' }), 'GID')).toBe('GID')
    expect(resolveProxyId(base({ proxyMode: 'follow' }), null)).toBeNull()
    // follow 无视本连接自己残留的 proxyId
    expect(resolveProxyId(base({ proxyMode: 'follow', proxyId: 'X' as never }), 'GID')).toBe('GID')
  })

  it('direct：永远直连，无视全局默认', () => {
    expect(resolveProxyId(base({ proxyMode: 'direct' }), 'GID')).toBeNull()
  })

  it('custom：取本连接的 proxyId', () => {
    expect(resolveProxyId(base({ proxyMode: 'custom', proxyId: 'X' as never }), 'GID')).toBe('X')
    expect(resolveProxyId(base({ proxyMode: 'custom' }), 'GID')).toBeNull()
  })

  it('老数据无 proxyMode：有 proxyId→custom，无→direct（行为一字不变）', () => {
    // 迁移前配了代理的连接：继续走那条代理，不受全局默认影响
    expect(resolveProxyId(base({ proxyId: 'OLD' as never }), 'GID')).toBe('OLD')
    // 迁移前直连的连接：不会因为有人配了全局默认就突然改走代理
    expect(resolveProxyId(base({}), 'GID')).toBeNull()
  })
})
