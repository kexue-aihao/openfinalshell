import { describe, expect, it } from 'vitest'
import { flat, read, stripComments } from '../sourceGuard'

/**
 * 代理"全局默认 + 单连接三态"的接线护栏。护的都是"改回去也不报错、只是行为悄悄变"的点。
 */

const drawer = stripComments(read('src/renderer/src/features/connections/ProfileEditDrawer.tsx'))
const panel = stripComments(read('src/renderer/src/features/settings/SavedRefsPanel.tsx'))
const auth = stripComments(read('src/main/ssh/auth.ts'))
const conn = stripComments(read('src/main/store/connections.ts'))
const ipc = stripComments(read('src/main/ipc/conn.ipc.ts'))

describe('代理默认：main 侧', () => {
  it('resolveProxyId 三态齐全，且 follow 取全局默认', () => {
    expect(auth).toContain('export function resolveProxyId')
    expect(auth).toContain("profile.proxyMode ?? (profile.proxyId ? 'custom' : 'direct')")
    // buildConnectConfig 必须把全局默认喂进 resolveProxy，否则 follow 永远直连
    expect(flat(auth)).toContain('resolveProxy(profile, getSettings().connection.defaultProxyId)')
  })

  it('saveProfile 落库 proxyMode（不落的话三态选择存不住）', () => {
    expect(conn).toContain('proxyMode: draft.proxyMode')
  })

  it('zod 收 proxyMode 枚举', () => {
    expect(ipc).toContain("proxyMode: z.enum(['follow', 'direct', 'custom'])")
  })
})

describe('代理默认：渲染侧', () => {
  it('新建连接默认 follow —— "全局默认对新建连接生效"的落点', () => {
    expect(flat(drawer)).toContain("proxyMode: 'follow'")
  })

  it('提交时 proxyId 按 custom 门控，切走后不残留旧 id', () => {
    expect(drawer).toContain("proxyId: v.proxyMode === 'custom' ? v.proxyId || undefined : undefined")
  })

  it('设置页写的是 connection.defaultProxyId，空串归一成 null（直连）', () => {
    expect(panel).toContain('defaultProxyId: v || null')
  })
})
