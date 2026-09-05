import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileDraft } from '@shared/types'

const { database, prepare } = await import('../../src/main/store/Database')
const {
  deletePrivateKey,
  deleteProxy,
  getPrivateKey,
  getProxy,
  keyUsedBy,
  listPrivateKeys,
  listProxies,
  getManagedPrivateKeyMaterial,
  savePrivateKey,
  savePrivateKeyFromDraft,
  saveProxy,
  proxyUsedBy
} = await import('../../src/main/store/savedRefs')
const conns = await import('../../src/main/store/connections')
const { vault } = await import('../../src/main/store/Vault')
const { buildExportEnvelope } = await import('../../src/main/services/exportData')

/**
 * 「已保存的代理 / 私钥」这两类**被连接引用**的实体。
 *
 * 这一片最贵的错都不抛异常：删掉一台机器把别人的代理密码带走、复制连接留下 Vault 孤儿、
 * 被引用的实体被删掉之后那些连接连的时候才报错。所以下面每一组都对着一条这样的错写。
 */

beforeAll(() => {
  database()
})

beforeEach(() => {
  for (const table of ['profiles', 'proxies', 'private_keys', 'secrets']) {
    prepare(`DELETE FROM ${table}`).run()
  }
})

const draft = (name: string, over: Partial<ProfileDraft> = {}): ProfileDraft => ({
  name,
  groupId: null,
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  auth: { method: 'password' },
  terminal: { charset: 'utf-8', termType: 'xterm-256color' },
  options: {
    keepaliveInterval: 15000,
    readyTimeout: 10000,
    legacyAlgorithms: false,
    autoReconnect: false,
    monitorEnabled: false,
    compress: false
  },
  ...over
})

describe('代理：CRUD 与口令', () => {
  it('保存后库里只有引用，明文只在 Vault 里', () => {
    const p = saveProxy({
      name: '家里的 Clash',
      type: 'socks5',
      host: '127.0.0.1',
      port: 7890,
      username: 'pu',
      password: 'p-secret'
    })
    expect(p.passwordRef).toBeTruthy()
    expect(vault.getSecret(p.passwordRef!)).toBe('p-secret')

    // 直接翻库：JSON 列里不许有明文
    const row = prepare('SELECT json FROM proxies WHERE id = ?').get(p.id) as { json: string }
    expect(row.json).not.toContain('p-secret')
    expect(JSON.stringify(listProxies())).not.toContain('p-secret')
  })

  it('口令留空 = 保持原值；clearSecret 才真的清掉', () => {
    const p = saveProxy({ name: 'a', type: 'http', host: 'h', port: 1, password: 'keep' })
    const ref = p.passwordRef!

    const again = saveProxy({ id: p.id, name: 'a2', type: 'http', host: 'h', port: 1 })
    expect(again.passwordRef).toBe(ref)
    expect(vault.getSecret(ref)).toBe('keep')

    const cleared = saveProxy({
      id: p.id,
      name: 'a2',
      type: 'http',
      host: 'h',
      port: 1,
      clearSecret: true
    })
    expect(cleared.passwordRef).toBeUndefined()
    expect(vault.getSecret(ref)).toBeNull()
  })

  it('名字与地址存的是 trim 过的值', () => {
    const p = saveProxy({ name: '  n  ', type: 'http', host: '  1.2.3.4  ', port: 8080 })
    expect(p.name).toBe('n')
    expect(p.host).toBe('1.2.3.4')
  })
})

describe('删除：被引用就不删，并回报是谁在用', () => {
  it('代理被引用时不删、不抛错，回连接名清单', () => {
    const proxy = saveProxy({ name: 'shared', type: 'socks5', host: '127.0.0.1', port: 7890 })
    conns.saveProfile(draft('机器甲', { proxyId: proxy.id }))
    conns.saveProfile(draft('机器乙', { proxyId: proxy.id }))

    expect(proxyUsedBy(proxy.id).sort()).toEqual(['机器乙', '机器甲'])
    const r = deleteProxy(proxy.id)
    expect(r).toEqual({ deleted: false, usedBy: expect.arrayContaining(['机器甲', '机器乙']) })
    // 一条都没删
    expect(getProxy(proxy.id)).toBeDefined()
  })

  it('没人引用时删掉，且它的 Vault 条目一并清掉', () => {
    const proxy = saveProxy({
      name: 'lonely',
      type: 'http',
      host: 'h',
      port: 1,
      password: 'gone'
    })
    const ref = proxy.passwordRef!
    expect(deleteProxy(proxy.id)).toEqual({ deleted: true })
    expect(getProxy(proxy.id)).toBeUndefined()
    expect(vault.getSecret(ref)).toBeNull()
  })

  it('私钥同款：被引用不删，没人用才删且清口令', () => {
    const key = savePrivateKey({ name: 'k', path: '/home/u/.ssh/id_ed25519', passphrase: 'pp' })
    const ref = key.passphraseRef!
    conns.saveProfile(
      draft('用私钥的机器', { auth: { method: 'privateKey', privateKeyId: key.id } })
    )

    expect(keyUsedBy(key.id)).toEqual(['用私钥的机器'])
    expect(deletePrivateKey(key.id)).toEqual({ deleted: false, usedBy: ['用私钥的机器'] })
    expect(vault.getSecret(ref)).toBe('pp')

    // 把那条连接删掉之后就能删了
    const p = conns.listConnections().profiles.find((x) => x.name === '用私钥的机器')!
    conns.deleteProfile(p.id)
    expect(deletePrivateKey(key.id)).toEqual({ deleted: true })
    expect(getPrivateKey(key.id)).toBeUndefined()
    expect(vault.getSecret(ref)).toBeNull()
  })
})

/**
 * 共享语义。**这两条是这次改造最容易引进的 bug**，而且都不抛异常：
 * v0.3 的代理是内联的、ref 独占，所以那时"删连接顺手删代理密码""复制连接复制密码"
 * 都是对的；改成共享实体之后照抄那套行为就会误伤别人。
 */
describe('共享语义', () => {
  it('删掉一台机器，另一台仍能取到同一个代理的密码', () => {
    const proxy = saveProxy({
      name: 'shared',
      type: 'socks5',
      host: '127.0.0.1',
      port: 7890,
      password: 'shared-pw'
    })
    const ref = proxy.passwordRef!
    const a = conns.saveProfile(draft('甲', { proxyId: proxy.id }))
    conns.saveProfile(draft('乙', { proxyId: proxy.id }))

    conns.deleteProfile(a.id)

    expect(vault.getSecret(ref)).toBe('shared-pw')
    expect(getProxy(proxy.id)?.passwordRef).toBe(ref)
  })

  it('删机器仍然清掉它自己独占的登录密码（这一条不许跟着一起放宽）', () => {
    const p = conns.saveProfile(draft('甲', { auth: { method: 'password', password: 'own' } }))
    const own = conns.getProfile(p.id)!.auth.passwordRef!
    expect(vault.getSecret(own)).toBe('own')
    conns.deleteProfile(p.id)
    expect(vault.getSecret(own)).toBeNull()
  })

  it('复制连接：两条指向同一个代理/私钥 id，Vault 里不多出条目', () => {
    const proxy = saveProxy({ name: 'px', type: 'http', host: 'h', port: 1, password: 'pw' })
    const key = savePrivateKey({ name: 'k', path: '/k', passphrase: 'pp' })
    const src = conns.saveProfile(
      draft('原件', {
        proxyId: proxy.id,
        auth: { method: 'privateKey', privateKeyId: key.id, password: 'login' }
      })
    )
    const before = (prepare('SELECT COUNT(*) AS c FROM secrets').get() as { c: number }).c

    const copy = conns.duplicateProfile(src.id)

    expect(copy.proxyId).toBe(proxy.id)
    expect(copy.auth.privateKeyId).toBe(key.id)
    // 只多出一条：副本自己那份登录密码（独占的必须复制，否则删原件会带走副本的）
    const after = (prepare('SELECT COUNT(*) AS c FROM secrets').get() as { c: number }).c
    expect(after - before).toBe(1)
    expect(copy.auth.passwordRef).not.toBe(src.auth.passwordRef)
    expect(vault.getSecret(copy.auth.passwordRef!)).toBe('login')

    // 删掉副本之后，共享的两条与原件的密码都还在
    conns.deleteProfile(copy.id)
    expect(vault.getSecret(proxy.passwordRef!)).toBe('pw')
    expect(vault.getSecret(key.passphraseRef!)).toBe('pp')
    expect(vault.getSecret(conns.getProfile(src.id)!.auth.passwordRef!)).toBe('login')
  })
})

describe('列表顺序', () => {
  it('按名字排，便于在下拉框里找', () => {
    saveProxy({ name: 'b', type: 'http', host: 'h', port: 1 })
    saveProxy({ name: 'a', type: 'http', host: 'h', port: 2 })
    expect(listProxies().map((x) => x.name)).toEqual(['a', 'b'])

    savePrivateKey({ name: 'z', path: '/z' })
    savePrivateKey({ name: 'y', path: '/y' })
    expect(listPrivateKeys().map((x) => x.name)).toEqual(['y', 'z'])
  })
})

describe('私钥本机托管副本', () => {
  it('只在 main 读取文件并保存加密副本，返回对象不含私钥明文', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-key-copy-'))
    const path = join(dir, 'id_ed25519')
    const material = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n')
    writeFileSync(path, material)
    try {
      const key = await savePrivateKeyFromDraft({
        name: 'managed',
        path,
        storeManagedCopy: true
      })
      expect(key.materialRef).toBeTruthy()
      expect(key.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(getManagedPrivateKeyMaterial(key)).toEqual(material)
      expect(JSON.stringify(key)).not.toContain(material.toString())
      const row = prepare('SELECT json FROM private_keys WHERE id = ?').get(key.id) as { json: string }
      expect(row.json).not.toContain(material.toString())
      expect(readFileSync(path)).toEqual(material)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('删除私钥时同时清理托管副本的 Vault 引用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-key-copy-'))
    const path = join(dir, 'id_ed25519')
    writeFileSync(path, 'key')
    try {
      const key = await savePrivateKeyFromDraft({ name: 'managed', path, storeManagedCopy: true })
      expect(deletePrivateKey(key.id)).toEqual({ deleted: true })
      expect(vault.getSecret(key.materialRef!)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('修改路径但不刷新托管副本时清掉旧材料，避免新路径失效后误用旧私钥', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-key-copy-'))
    const oldPath = join(dir, 'old-key')
    const newPath = join(dir, 'new-key')
    writeFileSync(oldPath, 'old-material')
    try {
      const saved = await savePrivateKeyFromDraft({
        name: 'managed',
        path: oldPath,
        storeManagedCopy: true
      })
      const oldMaterialRef = saved.materialRef!
      expect(vault.getSecret(oldMaterialRef)).toBeTruthy()

      const changed = await savePrivateKeyFromDraft({
        id: saved.id,
        name: 'managed',
        path: newPath,
        storeManagedCopy: false
      })

      expect(changed.materialRef).toBeUndefined()
      expect(vault.getSecret(oldMaterialRef)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('SSH/RDP 类型切换时清理不再引用的 RDP 密码', () => {
    const rdp = conns.saveProfile({
      ...draft('rdp'),
      protocol: 'rdp',
      username: '',
      rdp: { password: 'rdp-secret' }
    })
    const ref = rdp.rdp?.passwordRef
    expect(ref).toBeTruthy()
    expect(vault.getSecret(ref!)).toBe('rdp-secret')

    conns.saveProfile({
      ...draft('ssh', { id: rdp.id }),
      protocol: 'ssh'
    })

    expect(conns.getProfile(rdp.id)?.rdp).toBeUndefined()
    expect(vault.getSecret(ref!)).toBeNull()
  })

  it('导出配置时剥离本机托管副本引用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-key-copy-'))
    const path = join(dir, 'id_ed25519')
    writeFileSync(path, 'key-material')
    try {
      const key = await savePrivateKeyFromDraft({ name: 'managed', path, storeManagedCopy: true })
      const built = buildExportEnvelope({ includeSecrets: false })
      expect(built.text).not.toContain(key.materialRef!)
      expect(built.text).toContain(key.sourceFingerprint!)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
