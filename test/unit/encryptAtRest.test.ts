import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '@shared/types'
import { testUserDataDir } from '../stubs/electron'

/**
 * 配置数据静态加密（at-rest）：一次性迁移把现有明文行就地加密，
 * 以及整文件加密导出（v2）→ 导入的往返。
 */
const { database, prepare } = await import('../../src/main/store/Database')
const { encryptExistingRowsOnce } = await import('../../src/main/store/encryptMigration')
const crypto = await import('../../src/main/store/crypto')
const { getProfile, upsertProfile, deleteProfile, listConnections } = await import(
  '../../src/main/store/connections'
)
const { upsertPrivateKey, getPrivateKey } = await import('../../src/main/store/savedRefs')
const hostkeys = await import('../../src/main/ssh/hostkeys')
const { listCommandHistory } = await import('../../src/main/store/commandHistory')
const { vault } = await import('../../src/main/store/Vault')
const { exportData } = await import('../../src/main/services/exportData')
const { inspectImport, applyImport, resetPendingImport } = await import(
  '../../src/main/services/importData'
)

beforeAll(() => {
  database()
})

function profile(over: Partial<ConnectionProfile> & { id: string }): ConnectionProfile {
  return {
    name: 'srv',
    protocol: 'ssh',
    groupId: null,
    host: '198.51.100.7',
    port: 22,
    username: 'admin',
    auth: { method: 'password' },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 20000,
      legacyAlgorithms: false,
      autoReconnect: true,
      monitorEnabled: true,
      compress: false
    },
    createdAt: 1,
    updatedAt: 1,
    ...over
  } as ConnectionProfile
}

describe('encryptExistingRowsOnce：现有明文行就地加密', () => {
  it('Tier A 列变密文、Tier B 重键成 token，store 读回不变，且幂等', () => {
    // 直接 raw INSERT 明文行，模拟未加密的老库（绕过会自动加密的 store 写入）
    prepare(
      'INSERT INTO profiles(id, name, group_id, json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
    ).run(
      'p-mig',
      '明文机器',
      null,
      JSON.stringify(profile({ id: 'p-mig', name: '明文机器', host: '203.0.113.9' })),
      1,
      1
    )
    prepare('INSERT INTO conn_groups(id, name, parent_id, sort_order) VALUES(?, ?, ?, ?)').run(
      'g-mig',
      '明文分组',
      null,
      0
    )
    prepare(
      'INSERT INTO known_hosts(key, key_type, fingerprint, added_at) VALUES(?, ?, ?, ?)'
    ).run('1.2.3.4:22:ssh-rsa', 'ssh-rsa', 'FP-MIG', 1000)
    prepare(
      'INSERT INTO command_history(command, last_used_at, use_count) VALUES(?, ?, ?)'
    ).run('secret-cmd --token=abc', 1000, 1)

    encryptExistingRowsOnce()

    // Tier A：raw 列已是密文、无明文
    const rawP = prepare('SELECT name, json FROM profiles WHERE id = ?').get('p-mig') as {
      name: string
      json: string
    }
    expect(rawP.name.startsWith('enc:1:')).toBe(true)
    expect(rawP.json.startsWith('enc:1:')).toBe(true)
    expect(rawP.json).not.toContain('203.0.113.9')
    const rawG = prepare('SELECT name FROM conn_groups WHERE id = ?').get('g-mig') as {
      name: string
    }
    expect(rawG.name.startsWith('enc:1:')).toBe(true)

    // store 读回明文不变
    expect(getProfile('p-mig')!.host).toBe('203.0.113.9')
    expect(listConnections().groups.find((g) => g.id === 'g-mig')!.name).toBe('明文分组')

    // Tier B：known_hosts 主键变 token（64 hex）、明文进 host_enc，等值查找照常命中
    const rawK = prepare('SELECT key, host_enc FROM known_hosts WHERE fingerprint = ?').get(
      'FP-MIG'
    ) as { key: string; host_enc: string | null }
    expect(rawK.key).toMatch(/^[0-9a-f]{64}$/)
    expect(rawK.host_enc && rawK.host_enc.startsWith('enc:1:')).toBe(true)
    expect(hostkeys.checkHostkey('1.2.3.4', 22, 'ssh-rsa', 'FP-MIG')).toEqual({ status: 'match' })
    expect(hostkeys.listKnownHosts().find((r) => r.fingerprintSha256 === 'FP-MIG')!.host).toBe(
      '1.2.3.4'
    )

    // Tier B：command_history 原文加密、raw 无明文、list 仍能还原
    const rawC = prepare('SELECT command, cmd_enc FROM command_history').all() as Array<{
      command: string
      cmd_enc: string | null
    }>
    expect(rawC.every((r) => !r.command.includes('secret-cmd'))).toBe(true)
    expect(listCommandHistory().some((c) => c.command === 'secret-cmd --token=abc')).toBe(true)

    // 幂等：再跑一次不改变结果（flag 已挡住）
    encryptExistingRowsOnce()
    expect(getProfile('p-mig')!.host).toBe('203.0.113.9')
  })
})

describe('整文件加密导出 v2 → 导入 往返', () => {
  const target = join(testUserDataDir, 'enc-export.json')
  const REF = () => vault.putSecret('pw-12345')

  it('导出文件无任何明文、formatVersion=2、无明文 data', async () => {
    const ref = REF()
    upsertProfile(profile({ id: 'srv1', name: 'srv', host: '198.51.100.7', auth: { method: 'password', passwordRef: ref } }))
    const r = await exportData({
      includeSecrets: true,
      encryptAll: true,
      passphrase: 'correct horse battery',
      targetPath: target
    })
    expect(r).not.toBeNull()
    const text = readFileSync(target, 'utf8')
    expect(text).not.toContain('198.51.100.7')
    expect(text).not.toContain('admin')
    expect(text).not.toContain('pw-12345')
    const env = JSON.parse(text)
    expect(env.formatVersion).toBe(2)
    expect(env.enc).toBeDefined()
    expect(env.data).toBeUndefined()
  })

  it('导入 v2：口令正确则配置与密码等值还原', async () => {
    // 先删掉本机这条（连同其 vault 密码），再从加密文件导回
    deleteProfile('srv1')
    expect(getProfile('srv1')).toBeUndefined()

    const preview = await inspectImport({ sourcePath: target })
    expect(preview!.encrypted).toBe(true)
    const res = await applyImport({
      token: preview!.token,
      passphrase: 'correct horse battery',
      conflict: 'skip',
      include: { profiles: true, snippets: true, forwards: true, knownHosts: true, settings: false }
    })
    expect(res.profiles).toBe(1)
    const p = getProfile('srv1')!
    expect(p.host).toBe('198.51.100.7')
    expect(p.username).toBe('admin')
    expect(vault.getSecret(p.auth.passwordRef!)).toBe('pw-12345')
  })

  it('导入 v2：口令错误抛错、不动库', async () => {
    resetPendingImport()
    const preview = await inspectImport({ sourcePath: target })
    await expect(
      applyImport({
        token: preview!.token,
        passphrase: 'wrong passphrase',
        conflict: 'skip',
        include: { profiles: true, snippets: true, forwards: true, knownHosts: true, settings: false }
      })
    ).rejects.toThrow()
  })
})

describe('回归：写入即加密 / 列表逐行降级', () => {
  it('安全后端恢复后会重扫并加密降级期间写入的明文', () => {
    const original = safeStorage.isEncryptionAvailable
    try {
      safeStorage.isEncryptionAvailable = (): boolean => false
      crypto._resetDataKeyCacheForTests()
      upsertProfile(profile({ id: 'p-fallback', name: 'fallback', host: '192.0.2.10' }))
      const plain = prepare('SELECT json FROM profiles WHERE id = ?').get('p-fallback') as {
        json: string
      }
      expect(plain.json.startsWith('enc:1:')).toBe(false)
    } finally {
      safeStorage.isEncryptionAvailable = original
      crypto._resetDataKeyCacheForTests()
    }

    // rows_encrypted_v1 已由前面的迁移写过；dirty 标记必须允许这次恢复重扫。
    encryptExistingRowsOnce()
    const encrypted = prepare('SELECT json FROM profiles WHERE id = ?').get('p-fallback') as {
      json: string
    }
    expect(encrypted.json.startsWith('enc:1:')).toBe(true)
    expect(getProfile('p-fallback')?.host).toBe('192.0.2.10')
  })

  it('upsertPrivateKey 写入即加密（name 与 json 列都是密文，曾漏了 encField）', () => {
    upsertPrivateKey({
      id: 'k-enc',
      name: 'prod-key',
      path: 'C:/keys/id_ed25519',
      note: 'root box',
      createdAt: 1,
      updatedAt: 1
    })
    const raw = prepare('SELECT name, json FROM private_keys WHERE id = ?').get('k-enc') as {
      name: string
      json: string
    }
    expect(raw.name.startsWith('enc:1:')).toBe(true)
    expect(raw.json.startsWith('enc:1:')).toBe(true)
    expect(raw.json).not.toContain('id_ed25519')
    expect(getPrivateKey('k-enc')!.path).toBe('C:/keys/id_ed25519')
  })

  it('列表读取跳过解不开的行、不整块抛错（换机 key 丢失的优雅降级）', () => {
    // 塞一条假密文行（合法 base64 但不是真密文），decField 会抛错
    prepare(
      'INSERT INTO profiles(id, name, group_id, json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
    ).run(
      'p-bad',
      'enc:1:' + Buffer.from('not-a-real-name').toString('base64'),
      null,
      'enc:1:' + Buffer.from('not-a-real-ciphertext').toString('base64'),
      1,
      1
    )
    // 不抛错；坏行被跳过；正常行仍在
    expect(() => listConnections()).not.toThrow()
    const { profiles } = listConnections()
    expect(profiles.some((p) => p.id === 'p-bad')).toBe(false)
    expect(profiles.some((p) => p.id === 'srv1')).toBe(true)
  })
})
