import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDecipheriv, scryptSync } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { testUserDataDir } from '../stubs/electron'

/**
 * SQLite 存储层 + 旧 JSON 配置迁移。
 *
 * 必须在 import 任何 store 模块之前把旧 JSON 写好 —— database() 首次打开时才做导入，
 * 之后由 meta 里的标记挡住，不会重复执行。
 */

const configDir = join(testUserDataDir, 'config')
const LEGACY_PROFILE_ID = '11111111-1111-4111-8111-111111111111'
const LEGACY_GROUP_ID = '22222222-2222-4222-8222-222222222222'

mkdirSync(configDir, { recursive: true })
writeFileSync(
  join(configDir, 'settings.json'),
  JSON.stringify({ version: 1, language: 'en-US', terminal: { fontSize: 17 } }),
  'utf8'
)
writeFileSync(
  join(configDir, 'connections.json'),
  JSON.stringify({
    version: 1,
    groups: [{ id: LEGACY_GROUP_ID, name: '旧分组', parentId: null, order: 3 }],
    profiles: [
      {
        id: LEGACY_PROFILE_ID,
        name: '旧连接',
        groupId: LEGACY_GROUP_ID,
        host: '203.0.113.5',
        port: 2222,
        username: 'root',
        auth: { method: 'password', passwordRef: 'ref-legacy' },
        terminal: { charset: 'gbk', termType: 'xterm' },
        options: {
          keepaliveInterval: 15000,
          readyTimeout: 12000,
          legacyAlgorithms: true,
          autoReconnect: false,
          monitorEnabled: false,
          compress: true
        },
        createdAt: 1700000000000,
        updatedAt: 1700000000001,
        lastUsedAt: 1700000000002
      }
    ]
  }),
  'utf8'
)
writeFileSync(
  join(configDir, 'quick-commands.json'),
  JSON.stringify({
    version: 1,
    groups: [{ id: 'g1', name: '旧命令组', order: 1 }],
    snippets: [
      { id: 's1', groupId: 'g1', name: '看盘', command: 'df -h', autoEnter: true, order: 0 }
    ]
  }),
  'utf8'
)
writeFileSync(
  join(configDir, 'known_hosts.json'),
  JSON.stringify({
    version: 1,
    entries: {
      '203.0.113.5:2222:ssh-ed25519': {
        keyType: 'ssh-ed25519',
        fingerprintSha256: 'LEGACYFP',
        addedAt: 1700000000003
      }
    }
  }),
  'utf8'
)
writeFileSync(
  join(configDir, 'forwards.json'),
  JSON.stringify({
    version: 1,
    rules: [
      {
        id: 'f1',
        profileId: LEGACY_PROFILE_ID,
        type: 'local',
        label: '旧转发',
        bindAddr: '127.0.0.1',
        bindPort: 15432,
        dstHost: '127.0.0.1',
        dstPort: 5432,
        autoStart: true
      }
    ]
  }),
  'utf8'
)
// vault 里的"密文"用桩的 safeStorage 现造，保证解得开
const { safeStorage } = await import('../stubs/electron')
writeFileSync(
  join(configDir, 'vault.json'),
  JSON.stringify({
    version: 1,
    entries: { 'ref-legacy': safeStorage.encryptString('旧密码-🔑').toString('base64') }
  }),
  'utf8'
)

const { database, databaseFile, metaGet, tx, prepare } = await import(
  '../../src/main/store/Database'
)
const conns = await import('../../src/main/store/connections')
const { vault } = await import('../../src/main/store/Vault')
const snippets = await import('../../src/main/store/snippets')
const forwards = await import('../../src/main/store/forwards')
const hostkeys = await import('../../src/main/ssh/hostkeys')
const settings = await import('../../src/main/services/settings')
const { exportData } = await import('../../src/main/services/exportData')

beforeAll(() => {
  database() // 触发建表 + 一次性迁移
})

describe('SQLite 存储：旧 JSON 配置迁移', () => {
  it('数据库文件建在 config 目录下', () => {
    expect(existsSync(databaseFile())).toBe(true)
  })

  it('连接与分组带着嵌套字段一起迁移', () => {
    const { profiles, groups } = conns.listConnections()
    const p = profiles.find((x) => x.id === LEGACY_PROFILE_ID)
    expect(p).toBeDefined()
    expect(p!.host).toBe('203.0.113.5')
    expect(p!.terminal.charset).toBe('gbk')
    expect(p!.options.legacyAlgorithms).toBe(true)
    expect(p!.auth.passwordRef).toBe('ref-legacy')
    expect(groups.find((g) => g.id === LEGACY_GROUP_ID)?.order).toBe(3)
  })

  it('凭据密文迁移后仍能解出原文', () => {
    expect(vault.getSecret('ref-legacy')).toBe('旧密码-🔑')
  })

  it('快捷命令 / 转发 / known_hosts 一并迁移', () => {
    expect(snippets.listSnippets().snippets.some((s) => s.command === 'df -h')).toBe(true)
    expect(forwards.listForwards(LEGACY_PROFILE_ID).map((f) => f.bindPort)).toContain(15432)
    expect(hostkeys.checkHostkey('203.0.113.5', 2222, 'ssh-ed25519', 'LEGACYFP')).toEqual({
      status: 'match'
    })
  })

  it('设置迁移后与默认值深合并：老文件缺的嵌套字段取默认值而非 undefined', () => {
    const s = settings.getSettings()
    expect(s.language).toBe('en-US') // 来自旧文件
    expect(s.terminal.fontSize).toBe(17) // 来自旧文件
    expect(s.terminal.scrollback).toBeGreaterThan(0) // 旧文件没有 → 默认值
    expect(s.sftp.maxConcurrentGlobal).toBeGreaterThan(0)
  })

  it('迁移后旧文件改名为 .migrated（保留而不删，便于人工核对）', () => {
    expect(existsSync(join(configDir, 'connections.json'))).toBe(false)
    expect(existsSync(join(configDir, 'connections.json.migrated'))).toBe(true)
    expect(metaGet('legacy_json_imported')).toBeTruthy()
  })
})

describe('SQLite 存储：读写语义', () => {
  it('保存/改名/删除连接按行生效，删除时级联清掉其转发规则与凭据', () => {
    const saved = conns.saveProfile({
      name: 'row-test',
      groupId: null,
      host: '203.0.113.9',
      port: 22,
      username: 'root',
      auth: { method: 'password', password: 'pw' },
      terminal: { charset: 'utf-8', termType: 'xterm-256color' },
      options: {
        keepaliveInterval: 15000,
        readyTimeout: 10000,
        legacyAlgorithms: false,
        autoReconnect: true,
        monitorEnabled: true,
        compress: false
      }
    })
    const ref = saved.auth.passwordRef!
    expect(vault.getSecret(ref)).toBe('pw')
    forwards.saveForward({
      id: 'fwd-row',
      profileId: saved.id,
      type: 'local',
      label: 'x',
      bindAddr: '127.0.0.1',
      bindPort: 15999,
      dstHost: '127.0.0.1',
      dstPort: 80,
      autoStart: false
    })

    conns.deleteProfile(saved.id)
    expect(conns.getProfile(saved.id)).toBeUndefined()
    expect(vault.getSecret(ref)).toBeNull()
    expect(forwards.getForward('fwd-row')).toBeUndefined()
  })

  it('删除分组时组内连接上移到父级而不是被删掉', () => {
    conns.saveGroup({ id: 'gp', name: '父', parentId: null, order: 0 })
    conns.saveGroup({ id: 'gc', name: '子', parentId: 'gp', order: 1 })
    const p = conns.saveProfile({
      name: 'in-child',
      groupId: 'gc',
      host: 'h',
      port: 22,
      username: 'u',
      auth: { method: 'agent' },
      terminal: { charset: 'utf-8', termType: 'xterm' },
      options: {
        keepaliveInterval: 0,
        readyTimeout: 10000,
        legacyAlgorithms: false,
        autoReconnect: false,
        monitorEnabled: false,
        compress: false
      }
    })
    conns.deleteGroup('gc')
    expect(conns.getProfile(p.id)?.groupId).toBe('gp')
    conns.deleteProfile(p.id)
  })

  it('事务出错整体回滚', () => {
    const before = conns.listConnections().profiles.length
    expect(() =>
      tx(() => {
        prepare(
          `INSERT INTO profiles(id, name, group_id, json, created_at, updated_at)
           VALUES('tx-1','x',NULL,'{}',1,1)`
        ).run()
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(conns.listConnections().profiles.length).toBe(before)
  })
})

describe('导出应用数据', () => {
  it('默认不含密码，且文件里不出现任何明文', async () => {
    const target = join(testUserDataDir, 'export-plain.json')
    const r = await exportData({ includeSecrets: false, targetPath: target })
    expect(r).not.toBeNull()
    const text = await readFile(target, 'utf8')
    expect(text).not.toContain('旧密码')
    expect(text).not.toContain('🔑')
    const env = JSON.parse(text)
    expect(env.includesSecrets).toBe(false)
    expect(env.secrets).toBeUndefined()
    expect(env.data.profiles.some((p: { id: string }) => p.id === LEGACY_PROFILE_ID)).toBe(true)
    // 引用 id 可以留（它不是秘密），但必须说清楚导入后要重填密码
    expect(env.note).toMatch(/不含任何密码/)
  })

  it('勾选含密码时用导出口令加密，口令正确才解得开', async () => {
    const target = join(testUserDataDir, 'export-sealed.json')
    const r = await exportData({
      includeSecrets: true,
      passphrase: 'correct horse battery',
      targetPath: target
    })
    expect(r!.secrets).toBeGreaterThan(0)
    const env = JSON.parse(await readFile(target, 'utf8'))
    expect(env.includesSecrets).toBe(true)
    // 明文不得直接出现在文件里
    expect(JSON.stringify(env)).not.toContain('旧密码')

    const open = (pass: string): Record<string, string> => {
      const s = env.secrets
      const key = scryptSync(pass, Buffer.from(s.salt, 'base64'), 32, {
        N: s.n,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024
      })
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'))
      d.setAuthTag(Buffer.from(s.tag, 'base64'))
      return JSON.parse(
        Buffer.concat([d.update(Buffer.from(s.cipher, 'base64')), d.final()]).toString('utf8')
      )
    }
    expect(open('correct horse battery')['ref-legacy']).toBe('旧密码-🔑')
    expect(() => open('wrong pass')).toThrow()
  })

  it('含密码导出必须给口令，且口令太短要拦下', async () => {
    await expect(exportData({ includeSecrets: true, targetPath: 'x' })).rejects.toThrow(
      /必须设置导出口令/
    )
    await expect(
      exportData({ includeSecrets: true, passphrase: 'short', targetPath: 'x' })
    ).rejects.toThrow(/至少 8 位/)
  })
})
