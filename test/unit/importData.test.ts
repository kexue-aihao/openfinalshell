import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { testUserDataDir } from '../stubs/electron'
import { database, prepare } from '../../src/main/store/Database'
import * as conns from '../../src/main/store/connections'
import * as snippets from '../../src/main/store/snippets'
import * as forwards from '../../src/main/store/forwards'
import * as hostkeys from '../../src/main/ssh/hostkeys'
import { vault } from '../../src/main/store/Vault'
import { getSettings, patchSettings } from '../../src/main/services/settings'
import { exportData } from '../../src/main/services/exportData'
import { applyImport, inspectImport, resetPendingImport } from '../../src/main/services/importData'
import type { ImportSelection } from '../../src/shared/types'

/**
 * 数据导入。重点不在"能读进来"，而在几条不能出错的语义：
 * 冲突策略、凭据引用的归属、主机指纹不被悄悄覆盖、坏条目不拖垮整个文件。
 */

const ALL: ImportSelection = {
  profiles: true,
  snippets: true,
  forwards: true,
  knownHosts: true,
  settings: true
}
const PASS = 'correct horse battery'
const PLAIN_PASSWORD = '超级密码-🔑'

const GROUP_ID = '44444444-4444-4444-8444-444444444444'
/** seed() 里新建的连接 id。saveProfile 对不存在的 id 会自己发新 id，所以只能事后取 */
let PROFILE_ID = ''

const defaultOptions = {
  keepaliveInterval: 15000,
  readyTimeout: 20000,
  legacyAlgorithms: false,
  autoReconnect: true,
  monitorEnabled: true,
  compress: false
}

function wipe(): void {
  for (const table of [
    'profiles',
    'conn_groups',
    'secrets',
    'snippets',
    'snippet_groups',
    'forwards',
    'known_hosts'
  ]) {
    prepare(`DELETE FROM ${table}`).run()
  }
}

/** 造一份有连接、分组、快捷命令、转发规则、已信任主机与密码的库 */
function seed(): void {
  wipe()
  conns.saveGroup({ id: GROUP_ID, name: '生产环境', parentId: null, order: 1 })
  PROFILE_ID = conns.saveProfile({
    name: '生产-web',
    groupId: GROUP_ID,
    host: '203.0.113.10',
    port: 2222,
    username: 'root',
    auth: { method: 'password', password: PLAIN_PASSWORD },
    terminal: { charset: 'gbk', termType: 'xterm', startupCommand: 'cd /srv' },
    options: { ...defaultOptions, legacyAlgorithms: true }
  }).id
  snippets.saveSnippetGroup({ id: 'sg-1', name: '排障', order: 0 })
  snippets.saveSnippet({
    id: 'sn-1',
    groupId: 'sg-1',
    name: '看负载',
    command: 'uptime',
    autoEnter: true,
    order: 0
  })
  forwards.saveForward({
    id: 'fw-1',
    profileId: PROFILE_ID,
    type: 'local',
    label: '本地 5432',
    bindAddr: '127.0.0.1',
    bindPort: 15432,
    dstHost: '127.0.0.1',
    dstPort: 5432,
    autoStart: true
  })
  hostkeys.trustHostkey('203.0.113.10', 2222, 'ssh-ed25519', 'FP-ORIGINAL')
}

/** seed 出来的库导出成文件，返回路径 */
async function exportSeed(name: string, withSecrets = true): Promise<string> {
  const target = join(testUserDataDir, name)
  const r = await exportData({
    includeSecrets: withSecrets,
    passphrase: withSecrets ? PASS : undefined,
    targetPath: target
  })
  expect(r).not.toBeNull()
  return target
}

/** 手写一个信封，用来构造导出功能不会产出的畸形输入 */
function writeEnvelope(name: string, patch: Record<string, unknown>): string {
  const target = join(testUserDataDir, name)
  writeFileSync(
    target,
    JSON.stringify({
      app: 'openfinalshell',
      formatVersion: 1,
      appVersion: '0.0.0-test',
      exportedAt: 1700000000000,
      includesSecrets: false,
      note: '',
      data: {
        groups: [],
        profiles: [],
        snippetGroups: [],
        snippets: [],
        forwards: [],
        knownHosts: []
      },
      ...patch
    }),
    'utf8'
  )
  return target
}

beforeEach(() => {
  database()
  resetPendingImport()
})

describe('导入：文件识别与结构校验', () => {
  it('不是 JSON、不是本应用的文件、格式版本过新，都要在动库之前拦下', async () => {
    const notJson = join(testUserDataDir, 'not-json.json')
    writeFileSync(notJson, '这不是 json', 'utf8')
    await expect(inspectImport({ sourcePath: notJson })).rejects.toThrow(/不是合法的 JSON/)

    const alien = join(testUserDataDir, 'alien.json')
    writeFileSync(alien, JSON.stringify({ app: 'putty', data: {} }), 'utf8')
    await expect(inspectImport({ sourcePath: alien })).rejects.toThrow(/不是 OpenFinalShell/)

    const future = writeEnvelope('future.json', { formatVersion: 99 })
    await expect(inspectImport({ sourcePath: future })).rejects.toThrow(/更新版本/)
  })

  it('单条结构不完整只跳过那一条，同文件里的好数据照常导入', async () => {
    wipe()
    const file = writeEnvelope('mixed.json', {
      data: {
        groups: [],
        profiles: [
          // 缺 username 与 port：核心字段不全，判定无效
          { id: 'bad-1', name: '坏连接', host: 'h', auth: { method: 'password' } },
          // terminal / options 整块缺失：这些有默认值，应当补齐而不是判无效
          {
            id: 'lean-1',
            name: '精简连接',
            groupId: null,
            host: '203.0.113.20',
            port: 22,
            username: 'root',
            auth: { method: 'agent' },
            createdAt: 1700000000000,
            updatedAt: 1700000000000
          }
        ],
        snippetGroups: [],
        snippets: [{ id: 'sn-bad', name: '没有命令的片段' }],
        forwards: [],
        knownHosts: []
      }
    })

    const preview = await inspectImport({ sourcePath: file })
    expect(preview!.invalid).toBe(2)
    expect(preview!.counts.profiles).toBe(1)

    const r = await applyImport({ token: preview!.token, conflict: 'skip', include: ALL })
    expect(r.profiles).toBe(1)
    expect(r.invalid).toBe(2)

    const lean = conns.getProfile('lean-1')!
    expect(lean.terminal.charset).toBe('utf-8')
    expect(lean.options.readyTimeout).toBeGreaterThan(0)
    expect(conns.getProfile('bad-1')).toBeUndefined()
  })

  it('token 用完即失效，随手再点一次不会重复导入', async () => {
    seed()
    const file = await exportSeed('token.json', false)
    const preview = await inspectImport({ sourcePath: file })
    await applyImport({ token: preview!.token, conflict: 'duplicate', include: ALL })
    await expect(
      applyImport({ token: preview!.token, conflict: 'duplicate', include: ALL })
    ).rejects.toThrow(/会话已失效/)
  })
})

describe('导入：往返', () => {
  it('导出再导入，连接/分组/快捷命令/转发/指纹与密码原样回来', async () => {
    seed()
    const file = await exportSeed('roundtrip.json')
    wipe()
    expect(conns.getProfile(PROFILE_ID)).toBeUndefined()

    const preview = await inspectImport({ sourcePath: file })
    expect(preview!.includesSecrets).toBe(true)
    expect(preview!.conflicts).toBe(0) // 库已清空
    expect(preview!.counts).toMatchObject({
      profiles: 1,
      groups: 1,
      snippets: 1,
      forwards: 1,
      knownHosts: 1,
      settings: true
    })

    const r = await applyImport({
      token: preview!.token,
      passphrase: PASS,
      conflict: 'skip',
      include: ALL
    })
    expect(r).toMatchObject({ profiles: 1, groups: 1, snippets: 1, forwards: 1, knownHosts: 1 })
    expect(r.secrets).toBe(1)

    const p = conns.getProfile(PROFILE_ID)!
    expect(p.host).toBe('203.0.113.10')
    expect(p.port).toBe(2222)
    expect(p.groupId).toBe(GROUP_ID)
    expect(p.terminal.charset).toBe('gbk')
    expect(p.terminal.startupCommand).toBe('cd /srv')
    expect(p.options.legacyAlgorithms).toBe(true)
    // 密码解得开才算真的恢复了
    expect(vault.getSecret(p.auth.passwordRef!)).toBe(PLAIN_PASSWORD)

    expect(conns.listConnections().groups.find((g) => g.id === GROUP_ID)?.name).toBe('生产环境')
    expect(snippets.listSnippets().snippets.find((s) => s.id === 'sn-1')?.command).toBe('uptime')
    expect(forwards.getForward('fw-1')?.bindPort).toBe(15432)
    expect(hostkeys.checkHostkey('203.0.113.10', 2222, 'ssh-ed25519', 'FP-ORIGINAL')).toEqual({
      status: 'match'
    })
  })

  it('口令错了给明确报错，且能原地重试 —— 不必重新选文件', async () => {
    seed()
    const file = await exportSeed('retry.json')
    wipe()
    const preview = await inspectImport({ sourcePath: file })

    await expect(
      applyImport({ token: preview!.token, passphrase: '口令不对啊', conflict: 'skip', include: ALL })
    ).rejects.toThrow(/口令不正确/)

    const r = await applyImport({
      token: preview!.token,
      passphrase: PASS,
      conflict: 'skip',
      include: ALL
    })
    expect(r.secrets).toBe(1)
  })

  it('不给口令也能导入连接，只是密码为空（连接时会提示输入）', async () => {
    seed()
    const file = await exportSeed('nopass.json')
    wipe()
    const preview = await inspectImport({ sourcePath: file })
    const r = await applyImport({ token: preview!.token, conflict: 'skip', include: ALL })

    expect(r.profiles).toBe(1)
    expect(r.secrets).toBe(0)
    expect(r.notes.some((n) => n.includes('未提供导出口令'))).toBe(true)
    // 引用还在，但库里没有对应密文 → buildConnectConfig 会走"索要一次性密码"分支
    const p = conns.getProfile(PROFILE_ID)!
    expect(p.auth.passwordRef).toBeTruthy()
    expect(vault.getSecret(p.auth.passwordRef!)).toBeNull()
  })
})

describe('导入：冲突策略', () => {
  it('skip 一条不动本机现有数据', async () => {
    seed()
    const file = await exportSeed('skip.json')
    // 本机把这条连接改掉，导入不该把改动冲走
    conns.saveProfile({
      id: PROFILE_ID,
      name: '被我改过的名字',
      groupId: GROUP_ID,
      host: '203.0.113.99',
      port: 22,
      username: 'root',
      auth: { method: 'agent' },
      terminal: { charset: 'utf-8', termType: 'xterm' },
      options: defaultOptions
    })

    const preview = await inspectImport({ sourcePath: file })
    expect(preview!.conflicts).toBe(1)
    const r = await applyImport({
      token: preview!.token,
      passphrase: PASS,
      conflict: 'skip',
      include: ALL
    })

    expect(r.profiles).toBe(0)
    expect(r.skipped).toBeGreaterThan(0)
    expect(conns.getProfile(PROFILE_ID)!.host).toBe('203.0.113.99')
  })

  it('overwrite 用文件里的数据覆盖同 id 那条', async () => {
    seed()
    const file = await exportSeed('overwrite.json')
    conns.saveProfile({
      id: PROFILE_ID,
      name: '被我改过的名字',
      groupId: GROUP_ID,
      host: '203.0.113.99',
      port: 22,
      username: 'root',
      auth: { method: 'agent' },
      terminal: { charset: 'utf-8', termType: 'xterm' },
      options: defaultOptions
    })

    const preview = await inspectImport({ sourcePath: file })
    const r = await applyImport({
      token: preview!.token,
      passphrase: PASS,
      conflict: 'overwrite',
      include: ALL
    })

    expect(r.profiles).toBe(1)
    const p = conns.getProfile(PROFILE_ID)!
    expect(p.name).toBe('生产-web')
    expect(p.host).toBe('203.0.113.10')
    expect(vault.getSecret(p.auth.passwordRef!)).toBe(PLAIN_PASSWORD)
  })

  it('duplicate 建副本并换新凭据引用：删掉副本不会连带删掉原连接的密码', async () => {
    seed()
    const file = await exportSeed('dup.json')
    const original = conns.getProfile(PROFILE_ID)!

    const preview = await inspectImport({ sourcePath: file })
    const r = await applyImport({
      token: preview!.token,
      passphrase: PASS,
      conflict: 'duplicate',
      include: ALL
    })
    expect(r.profiles).toBe(1)

    const copy = conns.listConnections().profiles.find((p) => p.id !== PROFILE_ID)!
    expect(copy.name).toBe('生产-web（导入）')
    expect(copy.host).toBe('203.0.113.10')
    // 副本落在同样是副本的新分组里，而不是挂到原分组上
    expect(copy.groupId).not.toBe(GROUP_ID)
    // 关键：两条连接不能共用同一条 vault 凭据
    expect(copy.auth.passwordRef).not.toBe(original.auth.passwordRef)
    expect(vault.getSecret(copy.auth.passwordRef!)).toBe(PLAIN_PASSWORD)

    conns.deleteProfile(copy.id)
    expect(vault.getSecret(original.auth.passwordRef!)).toBe(PLAIN_PASSWORD)
  })
})

describe('导入：安全与完整性边界', () => {
  it('主机指纹与本机记录不一致时保留本机记录，并明确告知 —— 不替用户吞掉中间人告警', async () => {
    seed()
    const file = await exportSeed('hostkey.json', false)
    // 本机记的指纹变了（真实场景里这正是需要弹警告的情形）
    hostkeys.trustHostkey('203.0.113.10', 2222, 'ssh-ed25519', 'FP-DIFFERENT')

    const preview = await inspectImport({ sourcePath: file })
    const r = await applyImport({ token: preview!.token, conflict: 'overwrite', include: ALL })

    expect(r.knownHosts).toBe(0)
    expect(hostkeys.checkHostkey('203.0.113.10', 2222, 'ssh-ed25519', 'FP-DIFFERENT')).toEqual({
      status: 'match'
    })
    expect(r.notes.some((n) => n.includes('指纹与本机记录不一致'))).toBe(true)
  })

  it('指向不存在连接的转发规则不导入，避免留下孤儿规则', async () => {
    wipe()
    const file = writeEnvelope('orphan.json', {
      data: {
        groups: [],
        profiles: [],
        snippetGroups: [],
        snippets: [],
        forwards: [
          {
            id: 'fw-orphan',
            profileId: 'nobody',
            type: 'local',
            label: 'x',
            bindAddr: '127.0.0.1',
            bindPort: 15999,
            dstHost: '127.0.0.1',
            dstPort: 80,
            autoStart: false
          }
        ],
        knownHosts: []
      }
    })
    const preview = await inspectImport({ sourcePath: file })
    const r = await applyImport({ token: preview!.token, conflict: 'skip', include: ALL })
    expect(r.forwards).toBe(0)
    expect(forwards.getForward('fw-orphan')).toBeUndefined()
  })

  it('未勾选的部分一条都不写', async () => {
    seed()
    const file = await exportSeed('partial.json')
    wipe()
    const preview = await inspectImport({ sourcePath: file })
    const r = await applyImport({
      token: preview!.token,
      passphrase: PASS,
      conflict: 'skip',
      include: { profiles: true, snippets: false, forwards: false, knownHosts: false, settings: false }
    })

    expect(r.profiles).toBe(1)
    expect(r.snippets).toBe(0)
    expect(r.forwards).toBe(0)
    expect(r.knownHosts).toBe(0)
    expect(r.settingsApplied).toBe(false)
    expect(snippets.listSnippets().snippets.find((s) => s.id === 'sn-1')).toBeUndefined()
  })

  it('设置导入：窗口状态与本机不存在的下载目录不跟着走', async () => {
    seed()
    patchSettings({ window: { width: 1000, height: 700, maximized: false } })
    const file = writeEnvelope('settings.json', {
      data: {
        settings: {
          version: 99,
          language: 'en-US',
          terminal: { fontSize: 19 },
          sftp: { downloadDir: 'Z:\\不存在的目录\\downloads', maxConcurrentGlobal: 7 },
          window: { width: 3000, height: 2000, maximized: true },
          // 已知键但类型不对，以及完全未知的键，都不该混进设置文档
          themeMode: 42,
          搞事的字段: { evil: true }
        },
        groups: [],
        profiles: [],
        snippetGroups: [],
        snippets: [],
        forwards: [],
        knownHosts: []
      }
    })

    const before = getSettings()
    const preview = await inspectImport({ sourcePath: file })
    const r = await applyImport({ token: preview!.token, conflict: 'skip', include: ALL })
    expect(r.settingsApplied).toBe(true)

    const s = getSettings() as unknown as Record<string, unknown>
    expect(s.language).toBe('en-US')
    expect((s.terminal as { fontSize: number }).fontSize).toBe(19)
    expect((s.sftp as { maxConcurrentGlobal: number }).maxConcurrentGlobal).toBe(7)
    // 本机窗口状态、结构版本号、无效类型、未知键一律不动
    expect((s.window as { width: number }).width).toBe(1000)
    expect(s.version).toBe(1)
    expect(s.themeMode).toBe(before.themeMode)
    expect(s.搞事的字段).toBeUndefined()
    expect((s.sftp as { downloadDir: string }).downloadDir).toBe(before.sftp.downloadDir)
    expect(r.notes.some((n) => n.includes('不存在'))).toBe(true)
  })
})
