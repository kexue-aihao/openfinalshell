import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { testUserDataDir } from '../stubs/electron'
import { database, prepare } from '../../src/main/store/Database'
import * as conns from '../../src/main/store/connections'
import * as snippets from '../../src/main/store/snippets'
import * as forwards from '../../src/main/store/forwards'
import * as hostkeys from '../../src/main/ssh/hostkeys'
import * as savedRefs from '../../src/main/store/savedRefs'
import { vault } from '../../src/main/store/Vault'
import { getSettings, patchSettings } from '../../src/main/services/settings'
import { buildExportEnvelope, exportData } from '../../src/main/services/exportData'
import {
  applyImport,
  inspectImport,
  inspectImportFromText,
  resetPendingImport
} from '../../src/main/services/importData'
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
    'known_hosts',
    'proxies',
    'private_keys'
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
        knownHosts: [],
        proxies: [],
        privateKeys: []
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
  it('RDP profile 与独立 Vault 密码导出后能完整导回', async () => {
    wipe()
    const saved = conns.saveProfile({
      name: '远程桌面',
      protocol: 'rdp',
      groupId: null,
      host: 'rdp.example',
      port: 3389,
      username: '',
      auth: { method: 'password' },
      rdp: {
        domain: 'CORP',
        password: 'rdp-secret',
        clipboard: false,
        certificatePolicy: 'strict'
      },
      terminal: { charset: 'utf-8', termType: 'xterm-256color' },
      options: defaultOptions
    })
    const file = await exportSeed('rdp-roundtrip.json', true)
    wipe()

    const preview = await inspectImport({ sourcePath: file })
    expect(preview!.invalid).toBe(0)
    expect(preview!.counts.profiles).toBe(1)
    const result = await applyImport({
      token: preview!.token,
      passphrase: PASS,
      conflict: 'skip',
      include: ALL
    })

    expect(result.profiles).toBe(1)
    expect(result.secrets).toBe(1)
    const restored = conns.getProfile(saved.id)!
    expect(restored).toMatchObject({
      protocol: 'rdp',
      username: '',
      rdp: {
        domain: 'CORP',
        clipboard: false,
        certificatePolicy: 'strict'
      }
    })
    expect(restored.rdp?.passwordRef).toBeTruthy()
    expect(vault.getSecret(restored.rdp!.passwordRef!)).toBe('rdp-secret')
  })

  it('overwrite RDP profile removes the no-longer-referenced local password', async () => {
    wipe()
    const exported = conns.saveProfile({
      name: '远程桌面',
      protocol: 'rdp',
      groupId: null,
      host: 'rdp.example',
      port: 3389,
      username: 'alice',
      auth: { method: 'password' },
      rdp: { password: 'incoming', clipboard: true, certificatePolicy: 'prompt' },
      terminal: { charset: 'utf-8', termType: 'xterm-256color' },
      options: defaultOptions
    })
    const file = await exportSeed('rdp-overwrite.json', true)
    const incomingRef = exported.rdp!.passwordRef!
    wipe()

    const localRef = vault.putSecret('local-only')
    conns.upsertProfile({
      ...exported,
      rdp: { ...exported.rdp, passwordRef: localRef }
    })
    const preview = await inspectImport({ sourcePath: file })
    await applyImport({
      token: preview!.token,
      passphrase: PASS,
      conflict: 'overwrite',
      include: ALL
    })

    expect(vault.getSecret(localRef)).toBeNull()
    expect(vault.getSecret(incomingRef)).toBe('incoming')
    expect(conns.getProfile(exported.id)?.rdp?.passwordRef).toBe(incomingRef)
  })

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
    patchSettings({
      window: { width: 1000, height: 700, maximized: false, editor: { width: 1100, height: 740, maximized: false } }
    })
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

  /**
   * 顶层键过滤挡不住**段内**那些只许 main 自己写的键：sftp 这一段类型对得上就整段进 patch。
   * 所以导入必须也过一遍 stripMainOnlyPaths —— 那条分层的红证在
   * test/unit/settingsGuard.test.ts（含"两个入口都还接着它"那组源码护栏）。
   *
   * 这里留的是**行为**的那一半：一段设置该照常导入。上一版这条用例的主角是
   * sftp.externalEditorPath（导入文件把它指向 payload.exe 就能让受害者每次编辑都执行它），
   * 那个字段随外部编辑器一起删掉了、表也空了，所以"被剥掉"这件事此刻没有主体可验 ——
   * 与其换个字段假装验一遍，不如把它交给那份注入了假路径的护栏。
   */
  it('设置导入：同段的键照常导入（剥离本身的红证在 settingsGuard）', async () => {
    seed()
    const file = writeEnvelope('settings-section.json', {
      data: {
        settings: { sftp: { maxConcurrentGlobal: 6, showHiddenFiles: false } },
        groups: [],
        profiles: [],
        snippetGroups: [],
        snippets: [],
        forwards: [],
        knownHosts: []
      }
    })

    const preview = await inspectImport({ sourcePath: file })
    const r = await applyImport({ token: preview!.token, conflict: 'skip', include: ALL })
    expect(r.settingsApplied).toBe(true)

    const s = getSettings()
    expect(s.sftp.maxConcurrentGlobal).toBe(6)
    expect(s.sftp.showHiddenFiles).toBe(false)
    // 表是空的，所以这一趟不该剥掉任何东西、也不该多出一条 note
    expect(r.notes.some((n) => n.includes('出于安全'))).toBe(false)
  })
})

describe('导入：可复用的代理与私钥', () => {
  /**
   * v0.4 起代理与私钥是独立实体，连接按 id 引用。往返必须把这层引用带过去 ——
   * 断言"密码还能用"而不只是"字段还在"：ref 对不上的话字段看着没问题，连接时才失败。
   */
  it('往返：连接仍指向同一条代理/私钥，密码与口令都还能用', async () => {
    wipe()
    const proxy = savedRefs.saveProxy({
      name: '共享代理',
      type: 'socks5',
      host: '127.0.0.1',
      port: 7890,
      password: 'px-pw'
    })
    const key = savedRefs.savePrivateKey({ name: 'k1', path: '/home/u/.ssh/id', passphrase: 'kp' })
    conns.saveProfile({
      name: '引用者',
      groupId: null,
      host: '10.0.0.9',
      port: 22,
      username: 'root',
      auth: { method: 'privateKey', privateKeyId: key.id },
      terminal: { charset: 'utf-8', termType: 'xterm-256color' },
      options: {
        keepaliveInterval: 15000,
        readyTimeout: 10000,
        legacyAlgorithms: false,
        autoReconnect: false,
        monitorEnabled: false,
        compress: false
      },
      proxyId: proxy.id
    })

    const file = await exportSeed('refs-roundtrip.json', true)
    wipe()
    const preview = await inspectImport({ sourcePath: file })
    expect(preview!.counts.proxies).toBe(1)
    expect(preview!.counts.privateKeys).toBe(1)

    const r = await applyImport({
      token: preview!.token,
      passphrase: PASS,
      conflict: 'overwrite',
      include: ALL
    })
    expect(r.proxies).toBe(1)
    expect(r.privateKeys).toBe(1)

    const p = conns.listConnections().profiles.find((x) => x.name === '引用者')!
    const px = savedRefs.getProxy(p.proxyId!)!
    const k = savedRefs.getPrivateKey(p.auth.privateKeyId!)!
    expect(px.host).toBe('127.0.0.1')
    expect(vault.getSecret(px.passwordRef!)).toBe('px-pw')
    expect(vault.getSecret(k.passphraseRef!)).toBe('kp')
  })

  it('duplicate 策略：副本指向**新**的代理，而不是原来那条', async () => {
    wipe()
    const proxy = savedRefs.saveProxy({ name: 'px', type: 'http', host: 'h', port: 1 })
    conns.saveProfile({
      name: '原件',
      groupId: null,
      host: 'h',
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
      proxyId: proxy.id
    })
    const file = await exportSeed('refs-dup.json', false)

    const preview = await inspectImport({ sourcePath: file })
    await applyImport({ token: preview!.token, conflict: 'duplicate', include: ALL })

    const copy = conns.listConnections().profiles.find((x) => x.name.includes('(imported)'))!
    expect(copy.proxyId).toBeTruthy()
    expect(copy.proxyId).not.toBe(proxy.id)
    expect(savedRefs.listProxies()).toHaveLength(2)
  })

  /**
   * **v0.3 及以前导出的文件**：代理与私钥内联在连接上，没有 proxies / privateKeys 两个数组。
   * 不补抽取的话，导进来的连接是"直连、没有私钥"—— 不报错，用户第一次连接才发现。
   */
  it('老格式文件：内联的代理与私钥被抽成可复用记录并挂上引用', async () => {
    wipe()
    const file = writeEnvelope('legacy-inline.json', {
      data: {
        groups: [],
        profiles: [
          {
            id: 'legacy-1',
            name: '老连接',
            groupId: null,
            host: '10.0.0.7',
            port: 22,
            username: 'root',
            auth: { method: 'privateKey', privateKeyPath: '/home/u/.ssh/legacy_key' },
            terminal: { charset: 'utf-8', termType: 'xterm' },
            options: {
              keepaliveInterval: 15000,
              readyTimeout: 10000,
              legacyAlgorithms: false,
              autoReconnect: false,
              monitorEnabled: false,
              compress: false
            },
            proxy: { type: 'socks5', host: '10.0.0.8', port: 1080 },
            createdAt: 1,
            updatedAt: 1
          }
        ],
        snippetGroups: [],
        snippets: [],
        forwards: [],
        knownHosts: []
      }
    })

    const preview = await inspectImport({ sourcePath: file })
    // 老文件里这两个数组是空的
    expect(preview!.counts.proxies).toBe(0)
    expect(preview!.counts.privateKeys).toBe(0)

    const r = await applyImport({ token: preview!.token, conflict: 'overwrite', include: ALL })
    // 抽取出来的算进结果里，并给一条说明
    expect(r.proxies).toBe(1)
    expect(r.privateKeys).toBe(1)
    expect(r.notes.some((n) => n.includes('older version'))).toBe(true)

    const p = conns.getProfile('legacy-1')!
    expect(p.proxyId).toBeTruthy()
    expect(savedRefs.getProxy(p.proxyId!)?.port).toBe(1080)
    expect(p.auth.privateKeyId).toBeTruthy()
    expect(savedRefs.getPrivateKey(p.auth.privateKeyId!)?.path).toBe('/home/u/.ssh/legacy_key')
  })

  it('反复导入同一个老文件不会堆出重复的代理', async () => {
    wipe()
    const file = writeEnvelope('legacy-twice.json', {
      data: {
        groups: [],
        profiles: [
          {
            id: 'legacy-2',
            name: '老连接',
            groupId: null,
            host: '10.0.0.7',
            port: 22,
            username: 'root',
            auth: { method: 'password' },
            terminal: { charset: 'utf-8', termType: 'xterm' },
            options: {
              keepaliveInterval: 15000,
              readyTimeout: 10000,
              legacyAlgorithms: false,
              autoReconnect: false,
              monitorEnabled: false,
              compress: false
            },
            proxy: { type: 'http', host: '10.0.0.8', port: 8080 },
            createdAt: 1,
            updatedAt: 1
          }
        ],
        snippetGroups: [],
        snippets: [],
        forwards: [],
        knownHosts: []
      }
    })
    for (const _ of [1, 2]) {
      const preview = await inspectImport({ sourcePath: file })
      await applyImport({ token: preview!.token, conflict: 'overwrite', include: ALL })
    }
    expect(savedRefs.listProxies()).toHaveLength(1)
  })
})

describe('导入：局域网接收（从内存文本进入，无文件）', () => {
  const CHANNEL_PASS = 'K'.repeat(43) // 通道密钥的替身：任意 ≥8 位串都能走 seal/open

  // 固定语言：main 侧 t() 读 getSettings().language，而前面有用例把它导成了 en-US，
  // 会污染这里的中文断言。钉成 zh-CN，让这一组不受运行顺序影响
  beforeEach(() => {
    patchSettings({ language: 'zh-CN' })
  })

  it('build → inspectFromText → apply 全链：计数即时可见、密码经 Vault 还原', async () => {
    // 发送侧：加密整包（连密码）——线上传的就是这段文本
    seed()
    const built = buildExportEnvelope({ includeSecrets: true, encryptAll: true, passphrase: CHANNEL_PASS })
    wipe()
    expect(conns.getProfile(PROFILE_ID)).toBeUndefined()

    // 接收侧：inspect 时就持有通道密钥 → 当场解密 → 计数是真实值（不像文件 v2 先报 0）
    const preview = inspectImportFromText(built.text, { source: 'PC-A (10.0.0.7)', passphrase: CHANNEL_PASS })
    expect(preview.source).toBe('lan')
    expect(preview.encrypted).toBe(false) // 对 apply 而言已是明文
    expect(preview.counts).toMatchObject({ profiles: 1, groups: 1, snippets: 1, forwards: 1, knownHosts: 1 })

    // apply **不带口令**：密码映射已在 inspect 时解出、躺在 pending 里
    const r = await applyImport({ token: preview.token, conflict: 'skip', include: ALL })
    expect(r).toMatchObject({ profiles: 1, groups: 1, snippets: 1, forwards: 1, knownHosts: 1, secrets: 1 })
    expect(vault.getSecret(conns.getProfile(PROFILE_ID)!.auth.passwordRef!)).toBe(PLAIN_PASSWORD)
  })

  it('通道密钥不对 → 当场解密就抛口令错（坏帧进不到确认框）', () => {
    seed()
    const built = buildExportEnvelope({ includeSecrets: true, encryptAll: true, passphrase: CHANNEL_PASS })
    expect(() => inspectImportFromText(built.text, { source: 'x', passphrase: 'K'.repeat(42) + 'X' })).toThrow(
      /口令不正确/
    )
  })

  it('超长文本在解析前就拒（帧层之外的第二道闸）', () => {
    const huge = '{"app":"openfinalshell","x":"' + 'a'.repeat(65 * 1024 * 1024) + '"}'
    expect(() => inspectImportFromText(huge, { source: 'x' })).toThrow(/过大|大/)
  })

  it('局域网预览顶掉进行中的文件预览：旧 token 的 apply 落在会话失效上', async () => {
    seed()
    const file = await exportSeed('preempt.json', false)
    const filePreview = await inspectImport({ sourcePath: file })
    // 局域网这份把单槽顶掉
    const built = buildExportEnvelope({ includeSecrets: false, encryptAll: true, passphrase: CHANNEL_PASS })
    inspectImportFromText(built.text, { source: 'PC-B', passphrase: CHANNEL_PASS })
    await expect(
      applyImport({ token: filePreview!.token, conflict: 'skip', include: ALL })
    ).rejects.toThrow(/会话已失效/)
  })
})
