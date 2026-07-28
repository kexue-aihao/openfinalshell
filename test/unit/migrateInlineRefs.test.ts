import { beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '@shared/types'

const { database, metaGet, prepare } = await import('../../src/main/store/Database')
const conns = await import('../../src/main/store/connections')
const { listPrivateKeys, listProxies } = await import('../../src/main/store/savedRefs')

/**
 * 内联代理 / 私钥路径 → 可复用实体的**一次性迁移**。
 *
 * 这是本片唯一**不可逆**的改库动作，而它写错的表现全是静默的：
 * 搬丢 `passwordRef` = 用户升级后所有代理密码要重填；去重键取错 = 该合的没合、
 * 或者该分开的被合掉（后者会丢口令）；标记没落 = 每次启动都再抽一遍，堆出一串重复记录。
 *
 * 所以这里**手工往库里塞 v0.3 形状的 profile**（绕过 saveProfile —— 它已经不写内联字段了），
 * 再调迁移，逐条断言。
 */

/** 直接写 profiles 表：v0.3 那会儿的 JSON 形状 */
function seedLegacy(p: Partial<ConnectionProfile> & { id: string; name: string }): void {
  const full = {
    groupId: null,
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    auth: { method: 'password' as const },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 10000,
      legacyAlgorithms: false,
      autoReconnect: false,
      monitorEnabled: false,
      compress: false
    },
    createdAt: 1,
    updatedAt: 1,
    ...p
  } as ConnectionProfile
  prepare(
    `INSERT INTO profiles(id, name, group_id, json, created_at, updated_at)
     VALUES(?, ?, NULL, ?, ?, ?)`
  ).run(full.id, full.name, JSON.stringify(full), full.createdAt, full.updatedAt)
}

beforeAll(() => {
  database()

  // ① 两条用**完全相同**的代理（应合成一条）
  seedLegacy({
    id: 'a',
    name: '甲',
    proxy: { type: 'socks5', host: '127.0.0.1', port: 7890, passwordRef: 'ref-px' }
  })
  seedLegacy({
    id: 'b',
    name: '乙',
    proxy: { type: 'socks5', host: '127.0.0.1', port: 7890, passwordRef: 'ref-px' }
  })
  // ② 端口不同 → 另一条代理
  seedLegacy({
    id: 'c',
    name: '丙',
    proxy: { type: 'socks5', host: '127.0.0.1', port: 1080 }
  })
  // ③ type='none'：不该产生任何代理记录
  seedLegacy({ id: 'd', name: '丁', proxy: { type: 'none', host: '', port: 7890 } })
  // ④ 两条同路径同口令的私钥（合成一条）
  seedLegacy({
    id: 'e',
    name: '戊',
    auth: { method: 'privateKey', privateKeyPath: '/home/u/.ssh/id_ed25519', passphraseRef: 'ref-pp' }
  })
  seedLegacy({
    id: 'f',
    name: '己',
    auth: { method: 'privateKey', privateKeyPath: '/home/u/.ssh/id_ed25519', passphraseRef: 'ref-pp' }
  })
  // ⑤ 同路径但**口令不同** → 必须另建一条，否则后者的口令就丢了
  seedLegacy({
    id: 'g',
    name: '庚',
    auth: {
      method: 'privateKey',
      privateKeyPath: '/home/u/.ssh/id_ed25519',
      passphraseRef: 'ref-pp-2'
    }
  })
  // ⑥ 路径非空但认证方式是密码 —— 那份路径仍是用户填过的真东西，照样要迁
  seedLegacy({
    id: 'h',
    name: '辛',
    auth: { method: 'password', privateKeyPath: '/home/u/.ssh/other_key' }
  })

  conns.migrateInlineRefsOnce()
})

const byName = (name: string): ConnectionProfile =>
  conns.listConnections().profiles.find((p) => p.name === name)!

describe('代理', () => {
  it('四要素相同的合成一条，不同的另建一条', () => {
    const proxies = listProxies()
    expect(proxies).toHaveLength(2)
    expect(byName('甲').proxyId).toBe(byName('乙').proxyId)
    expect(byName('丙').proxyId).not.toBe(byName('甲').proxyId)
  })

  /** 最要紧的一条：ref 原样搬过去。搬丢了就是"升级后所有代理密码都要重填"，而且不报错 */
  it('passwordRef 原样保留', () => {
    const px = listProxies().find((x) => x.port === 7890)!
    expect(px.passwordRef).toBe('ref-px')
  })

  it('名字默认取 host:port', () => {
    expect(listProxies().map((x) => x.name).sort()).toEqual([
      '127.0.0.1:1080',
      '127.0.0.1:7890'
    ])
  })

  it("type='none' 不产生代理记录，那条连接仍是直连", () => {
    expect(byName('丁').proxyId).toBeUndefined()
  })
})

describe('私钥', () => {
  it('同路径同口令合一条；同路径不同口令另建一条（否则丢口令）', () => {
    const keys = listPrivateKeys()
    // id_ed25519 两条（口令不同）+ other_key 一条
    expect(keys).toHaveLength(3)
    expect(byName('戊').auth.privateKeyId).toBe(byName('己').auth.privateKeyId)
    expect(byName('庚').auth.privateKeyId).not.toBe(byName('戊').auth.privateKeyId)
  })

  it('passphraseRef 原样保留', () => {
    const refs = listPrivateKeys()
      .map((k) => k.passphraseRef)
      .filter(Boolean)
      .sort()
    expect(refs).toEqual(['ref-pp', 'ref-pp-2'])
  })

  it('路径非空但认证方式是密码的也迁了 —— 那份路径不该丢', () => {
    const id = byName('辛').auth.privateKeyId
    expect(id).toBeTruthy()
    expect(listPrivateKeys().find((k) => k.id === id)?.path).toBe('/home/u/.ssh/other_key')
  })

  it('名字取文件名，重名加序号', () => {
    const names = listPrivateKeys().map((k) => k.name).sort()
    expect(names).toEqual(['id_ed25519', 'id_ed25519 (2)', 'other_key'])
  })
})

describe('只跑一次', () => {
  it('落了 meta 标记，重复调用不再抽第二遍', () => {
    expect(metaGet('inline_proxy_key_migrated_v1')).toBeTruthy()
    const proxiesBefore = listProxies().length
    const keysBefore = listPrivateKeys().length

    conns.migrateInlineRefsOnce()
    conns.migrateInlineRefsOnce()

    expect(listProxies()).toHaveLength(proxiesBefore)
    expect(listPrivateKeys()).toHaveLength(keysBefore)
  })
})

describe('旧字段保留', () => {
  /**
   * 迁移刻意**不删**旧字段：万一映射有偏差还能人工找回 ——
   * 与 v0.1.0 那次 JSON 迁移把原文件改名 `.migrated` 而不是删除是同一条取舍。
   */
  it('proxy / privateKeyPath 仍在 JSON 列里', () => {
    const row = prepare('SELECT json FROM profiles WHERE id = ?').get('a') as { json: string }
    expect(JSON.parse(row.json).proxy).toBeDefined()
    const row2 = prepare('SELECT json FROM profiles WHERE id = ?').get('e') as { json: string }
    expect(JSON.parse(row2.json).auth.privateKeyPath).toBe('/home/u/.ssh/id_ed25519')
  })
})
