import { createDecipheriv, randomUUID, scryptSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dialog } from 'electron'
import { z } from 'zod'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type {
  AppSettings,
  ConnectionProfile,
  ImportApplyOptions,
  ImportPreview,
  ImportResult
} from '@shared/types'
import { prepare, tx } from '../store/Database'
import { vault } from '../store/Vault'
import {
  extractInlineRefs,
  getProfile,
  saveGroup,
  upsertProfile
} from '../store/connections'
import { upsertPrivateKey, upsertProxy } from '../store/savedRefs'
import { saveForward } from '../store/forwards'
import { saveSnippet, saveSnippetGroup } from '../store/snippets'
import { getSettings, patchSettings, stripMainOnlyPaths } from './settings'
import { EXPORT_FORMAT_VERSION } from './exportData'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('import')

/** 导出文件是纯 JSON，正常也就几十 KB；给个上限免得选错文件把整个进程读爆 */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024

/**
 * 解密侧的 scrypt 内存上限。文件里的 N 是别人写的，必须先卡住范围再算 ——
 * 否则一个 N=2^24 的文件就能让主进程去申请几十 GB 内存。
 * 上限按 schema 允许的最大 N（2^17）算：128 * 2^17 * 8 = 128MiB。
 */
const SCRYPT_MAXMEM = 192 * 1024 * 1024
const SCRYPT_KEYLEN = 32

// ---------------------------------------------------------------------------
// 校验：文件内容一律当外部输入
// ---------------------------------------------------------------------------

/**
 * 逐条校验而不是整体校验，是刻意的：一条坏数据不该让整个文件导不进来。
 * 校验通不过的条目计数后跳过，并在结果里告诉用户跳了几条。
 *
 * 领域对象存的是 JSON 列 —— 不校验的话，缺字段的 profile 会一路写进库，
 * 直到某次连接时才在 profile.options.readyTimeout 上炸开。
 */
const idSchema = z.string().min(1).max(200)

const profileSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  groupId: idSchema
    .nullish()
    .transform((v) => v ?? null),
  color: z.string().max(20).optional(),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(120),
  auth: z.object({
    method: z.enum(['password', 'privateKey', 'agent']),
    passwordRef: idSchema.optional(),
    /** v0.4 起：引用一条已保存的私钥 */
    privateKeyId: idSchema.optional(),
    /** @deprecated v0.3 及以前的内联路径，导入后由 extractInlineRefs 补成引用 */
    privateKeyPath: z.string().max(1024).optional(),
    passphraseRef: idSchema.optional()
  }),
  // 缺失的可选块用默认值补齐，而不是判定整条无效
  terminal: z
    .object({
      charset: z.string().max(40).default('utf-8'),
      termType: z.string().max(40).default('xterm-256color'),
      startupCommand: z.string().max(4096).optional()
    })
    .default({}),
  options: z
    .object({
      keepaliveInterval: z.number().int().min(0).max(600_000).default(15_000),
      readyTimeout: z.number().int().min(1000).max(120_000).default(20_000),
      legacyAlgorithms: z.boolean().default(false),
      autoReconnect: z.boolean().default(true),
      monitorEnabled: z.boolean().default(true),
      compress: z.boolean().default(false)
    })
    .default({}),
  /** v0.7 起：连接协议（缺省 ssh） */
  protocol: z.enum(['ssh', 'rdp']).optional(),
  /** v0.7 起：代理归属方式（缺省按老规则从 proxyId 推） */
  proxyMode: z.enum(['follow', 'direct', 'custom']).optional(),
  /** v0.4 起：引用一条已保存的代理 */
  proxyId: idSchema.optional(),
  proxy: z
    .object({
      type: z.enum(['none', 'http', 'socks5']),
      host: z.string().max(255),
      port: z.number().int().min(1).max(65535),
      username: z.string().max(255).optional(),
      passwordRef: idSchema.optional()
    })
    .optional(),
  jumpHostId: idSchema.optional(),
  note: z.string().max(4096).optional(),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now()),
  lastUsedAt: z.number().optional()
})

const groupSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  parentId: idSchema
    .nullish()
    .transform((v) => v ?? null),
  order: z.number().default(0)
})

const snippetGroupSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  order: z.number().default(0)
})

const snippetSchema = z.object({
  id: idSchema,
  groupId: idSchema,
  name: z.string().min(1).max(120),
  command: z.string().max(8192),
  autoEnter: z.boolean().default(true),
  order: z.number().default(0)
})

const forwardSchema = z.object({
  id: idSchema,
  profileId: idSchema,
  type: z.enum(['local', 'remote', 'dynamic']),
  label: z.string().max(120).default(''),
  bindAddr: z.string().max(255),
  bindPort: z.number().int().min(1).max(65535),
  dstHost: z.string().max(255).optional(),
  dstPort: z.number().int().min(1).max(65535).optional(),
  autoStart: z.boolean().default(false)
})

/** key 是 "host:port:keyType" 复合串，原样搬 —— 拆回 host/port 遇到 IPv6 就没法还原 */
const knownHostSchema = z.object({
  key: z.string().min(3).max(400),
  keyType: z.string().min(1).max(60),
  fingerprintSha256: z.string().min(1).max(200),
  addedAt: z.number().default(() => Date.now())
})

/**
 * 可复用的代理与私钥（v0.4 起）。**必须排在 profiles 之前写入**：连接引用它们。
 * 老文件（v0.3 及以前）里没有这两个数组，`.default([])` 让它们照样能导入 ——
 * 那些文件里的内联代理与私钥路径由 extractInlineRefs 在写完连接之后补成引用。
 */
const savedProxySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  type: z.enum(['http', 'socks5']),
  host: z.string().max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).optional(),
  passwordRef: idSchema.optional(),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now())
})

const savedKeySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  path: z.string().min(1).max(1024),
  passphraseRef: idSchema.optional(),
  note: z.string().max(4096).optional(),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now())
})

const envelopeSchema = z.object({
  app: z.literal('openfinalshell'),
  formatVersion: z.number().int().min(1),
  appVersion: z.string().max(60).default('未知'),
  exportedAt: z.number().default(0),
  includesSecrets: z.boolean().default(false),
  data: z.object({
    settings: z.record(z.string(), z.unknown()).optional(),
    groups: z.array(z.unknown()).default([]),
    profiles: z.array(z.unknown()).default([]),
    snippetGroups: z.array(z.unknown()).default([]),
    snippets: z.array(z.unknown()).default([]),
    forwards: z.array(z.unknown()).default([]),
    knownHosts: z.array(z.unknown()).default([]),
    proxies: z.array(z.unknown()).default([]),
    privateKeys: z.array(z.unknown()).default([])
  }),
  secrets: z
    .object({
      kdf: z.literal('scrypt'),
      // 范围卡死：这个数直接决定我们要申请多少内存
      n: z.number().int().min(1 << 12).max(1 << 17),
      salt: z.string().max(200),
      iv: z.string().max(200),
      tag: z.string().max(200),
      cipher: z.string()
    })
    .optional()
})

type SealedSecrets = NonNullable<z.output<typeof envelopeSchema>['secrets']>

interface ParsedImport {
  appVersion: string
  exportedAt: number
  includesSecrets: boolean
  profiles: z.output<typeof profileSchema>[]
  groups: z.output<typeof groupSchema>[]
  snippetGroups: z.output<typeof snippetGroupSchema>[]
  snippets: z.output<typeof snippetSchema>[]
  forwards: z.output<typeof forwardSchema>[]
  knownHosts: z.output<typeof knownHostSchema>[]
  proxies: z.output<typeof savedProxySchema>[]
  privateKeys: z.output<typeof savedKeySchema>[]
  settings?: Record<string, unknown>
  secrets?: SealedSecrets
  invalid: number
}

function partition<S extends z.ZodTypeAny>(
  schema: S,
  items: unknown[]
): { ok: z.output<S>[]; bad: number } {
  const ok: z.output<S>[] = []
  let bad = 0
  for (const item of items) {
    const r = schema.safeParse(item)
    if (r.success) ok.push(r.data)
    else bad++
  }
  return { ok, bad }
}

function parseEnvelope(text: string): ParsedImport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('这个文件不是合法的 JSON，请确认选的是 OpenFinalShell 导出的文件')
  }
  const head = raw as { app?: unknown; formatVersion?: unknown }
  if (head?.app !== 'openfinalshell') {
    throw new Error('这不是 OpenFinalShell 导出的数据文件')
  }
  if (typeof head.formatVersion === 'number' && head.formatVersion > EXPORT_FORMAT_VERSION) {
    throw new Error(
      `该文件由更新版本导出（格式 v${head.formatVersion}，本机支持 v${EXPORT_FORMAT_VERSION}），请先升级 OpenFinalShell`
    )
  }
  const env = envelopeSchema.safeParse(raw)
  if (!env.success) {
    throw new Error('导出文件的结构不完整或已损坏，无法导入')
  }

  const d = env.data.data
  const profiles = partition(profileSchema, d.profiles)
  const groups = partition(groupSchema, d.groups)
  const snippetGroups = partition(snippetGroupSchema, d.snippetGroups)
  const snippets = partition(snippetSchema, d.snippets)
  const forwards = partition(forwardSchema, d.forwards)
  const knownHosts = partition(knownHostSchema, d.knownHosts)
  const proxies = partition(savedProxySchema, d.proxies)
  const privateKeys = partition(savedKeySchema, d.privateKeys)

  return {
    appVersion: env.data.appVersion,
    exportedAt: env.data.exportedAt,
    includesSecrets: env.data.includesSecrets && env.data.secrets !== undefined,
    profiles: profiles.ok,
    groups: groups.ok,
    snippetGroups: snippetGroups.ok,
    snippets: snippets.ok,
    forwards: forwards.ok,
    knownHosts: knownHosts.ok,
    proxies: proxies.ok,
    privateKeys: privateKeys.ok,
    settings: d.settings,
    secrets: env.data.secrets,
    invalid:
      profiles.bad +
      groups.bad +
      snippetGroups.bad +
      snippets.bad +
      forwards.bad +
      knownHosts.bad +
      proxies.bad +
      privateKeys.bad
  }
}

// ---------------------------------------------------------------------------
// 第一步：选文件 + 解析，暂存等用户确认
// ---------------------------------------------------------------------------

interface Pending {
  token: string
  path: string
  parsed: ParsedImport
}

/** 单槽暂存：renderer 只持有 token，不接触文件路径，也不会重复读盘（避免 TOCTOU） */
let pending: Pending | null = null
let applying = false

export async function inspectImport(opts: { sourcePath?: string } = {}): Promise<ImportPreview | null> {
  let source = opts.sourcePath
  if (!source) {
    const r = await dialog.showOpenDialog({
      title: '导入应用数据',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    source = r.filePaths[0]
  }

  const info = await stat(source)
  if (info.size > MAX_IMPORT_BYTES) {
    throw new Error(`文件太大（${Math.round(info.size / 1024 / 1024)}MB），不像是导出的配置文件`)
  }
  const parsed = parseEnvelope(await readFile(source, 'utf8'))

  const conflicts = parsed.profiles.filter((p) => getProfile(p.id) !== undefined).length
  pending = { token: randomUUID(), path: source, parsed }
  log.info(
    `import preview ${source}: ${parsed.profiles.length} profiles, secrets=${parsed.includesSecrets}, invalid=${parsed.invalid}`
  )

  return {
    token: pending.token,
    path: source,
    appVersion: parsed.appVersion,
    exportedAt: parsed.exportedAt,
    includesSecrets: parsed.includesSecrets,
    counts: {
      profiles: parsed.profiles.length,
      groups: parsed.groups.length,
      proxies: parsed.proxies.length,
      privateKeys: parsed.privateKeys.length,
      snippets: parsed.snippets.length,
      forwards: parsed.forwards.length,
      knownHosts: parsed.knownHosts.length,
      settings: parsed.settings !== undefined
    },
    invalid: parsed.invalid,
    conflicts
  }
}

// ---------------------------------------------------------------------------
// 密码段
// ---------------------------------------------------------------------------

function openSecrets(sealed: SealedSecrets, passphrase: string): Record<string, string> {
  const key = scryptSync(passphrase, Buffer.from(sealed.salt, 'base64'), SCRYPT_KEYLEN, {
    N: sealed.n,
    r: 8,
    p: 1,
    maxmem: SCRYPT_MAXMEM
  })
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  let json: string
  try {
    json = Buffer.concat([
      d.update(Buffer.from(sealed.cipher, 'base64')),
      d.final()
    ]).toString('utf8')
  } catch {
    // GCM 校验失败：口令不对，或文件被改过 —— 两者无法区分，一起说
    throw new Error('导出口令不正确，或文件的密码段已损坏')
  }
  const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(json))
  if (!parsed.success) throw new Error('文件的密码段格式异常')
  return parsed.data
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/**
 * 只放行 DEFAULT_SETTINGS 里已有的顶层键、且类型对得上 ——
 * 导入文件可能来自别人，不能让任意结构直接 deepMerge 进设置文档。
 *
 * ⚠️ 顶层键这一层只管结构，管不到**段内**那些只许 main 自己写的键：sftp 只要
 * `typeof value === typeof defaults.sftp` 成立就整段原样进 patch。
 * 这条路的用途正是换机迁移 / 同事分享一份导出文件，所以它和渲染进程一样是**外来数据**，
 * 必须也过一遍 stripMainOnlyPaths（那份实现与分层说明见 ./settings.ts）。
 *
 * 这一条是踩出来的：上一版只有 settings:set 剥，这条路整条绕过去 —— 当时表里那个键
 * （外部编辑器的 exe 路径）一旦被导入文件写进来，此后每次编辑都会执行它，全程静默。
 * 那个字段现在随外部编辑器一起删掉了、表也空了，但**入口必须一直接着**：
 * 下一次往表里加键的人不该再重新发现一遍这件事。
 *
 * 刻意不导入的三项：
 * - window：窗口尺寸与最大化状态是本机状态，跟着别人的机器走可能让窗口落到屏幕外
 * - version：设置文档的结构版本号归本机所有，跟着文件走会骗过将来的设置迁移逻辑
 * - sftp.downloadDir：那是对方机器上的路径，本机不存在时留着只会让每次下载都失败
 */
function sanitizeSettings(raw: Record<string, unknown>): {
  patch: Partial<AppSettings>
  notes: string[]
} {
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  const notes: string[] = []

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'window' || key === 'version') continue
    if (!(key in defaults)) continue
    if (value === null || typeof value !== typeof defaults[key]) continue
    patch[key] = value
  }
  if ('window' in raw) notes.push('窗口尺寸与最大化状态属于本机状态，未随导入改变')

  const sftp = patch.sftp as Record<string, unknown> | undefined
  if (sftp && typeof sftp.downloadDir === 'string' && sftp.downloadDir !== '') {
    if (!existsSync(sftp.downloadDir)) {
      notes.push(`导入的下载目录 ${sftp.downloadDir} 在本机不存在，已保留原设置`)
      const copy = { ...sftp }
      delete copy.downloadDir
      patch.sftp = copy
    }
  }

  /**
   * 剥掉只许 main 自己写的键，并往 notes 里说人话 —— notes 是会显示给用户的：
   * 静默丢掉的话，用户只会发现"导了配置，可某一项怎么没跟过来"，然后无从查起。
   *
   * 文案里**把剥掉的键名列出来**，不写死某一个字段：那张表目前是空的，
   * 这段代码此刻不会执行；等它再有内容时，这句提示不需要有人记得回来改。
   */
  const guarded = stripMainOnlyPaths(patch as Partial<AppSettings>, getSettings())
  if (guarded.stripped.length > 0) {
    notes.push(`出于安全，以下设置未随文件导入，请在设置里重新指定：${guarded.stripped.join('、')}`)
  }
  return { patch: guarded.patch, notes }
}

// ---------------------------------------------------------------------------
// 第二步：写入
// ---------------------------------------------------------------------------

function rowExists(table: string, column: string, value: string): boolean {
  return prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value) !== undefined
}

export async function applyImport(opts: ImportApplyOptions): Promise<ImportResult> {
  if (!pending || pending.token !== opts.token) {
    throw new Error('导入会话已失效，请重新选择文件')
  }
  if (applying) throw new Error('上一次导入还在进行中')

  const { parsed } = pending
  const dup = opts.conflict === 'duplicate'
  const notes: string[] = []

  // 口令先验证再动库：口令输错是最常见的失败，不该让用户重新选一遍文件
  let secretMap: Record<string, string> = {}
  if (parsed.secrets && opts.passphrase) {
    secretMap = openSecrets(parsed.secrets, opts.passphrase)
  } else if (parsed.secrets && opts.include.profiles) {
    notes.push('未提供导出口令，连接已导入但密码为空，首次连接时会提示输入')
  }

  const vaultOk = Object.keys(secretMap).length === 0 || vault.isAvailable()
  if (!vaultOk) {
    notes.push('本机无法安全保存密码（safeStorage 不可用），密码未写入，连接时会提示输入')
  }

  const result: ImportResult = {
    profiles: 0,
    groups: 0,
    proxies: 0,
    privateKeys: 0,
    snippets: 0,
    forwards: 0,
    knownHosts: 0,
    secrets: 0,
    settingsApplied: false,
    skipped: 0,
    invalid: parsed.invalid,
    notes
  }

  applying = true
  try {
    tx(() => {
      // duplicate 模式：先把全部新 id 分配好，第二遍写入时才能正确改写彼此的引用
      const groupIds = new Map<string, string>()
      const profileIds = new Map<string, string>()
      const snippetGroupIds = new Map<string, string>()
      const proxyIds = new Map<string, string>()
      const keyIds = new Map<string, string>()
      if (dup) {
        for (const g of parsed.groups) groupIds.set(g.id, randomUUID())
        for (const p of parsed.profiles) profileIds.set(p.id, randomUUID())
        // 不预分配的话，副本连接会指回**原来那条**代理/私钥
        for (const x of parsed.proxies) proxyIds.set(x.id, randomUUID())
        for (const k of parsed.privateKeys) keyIds.set(k.id, randomUUID())
        for (const g of parsed.snippetGroups) snippetGroupIds.set(g.id, randomUUID())
      }
      const mapId = (m: Map<string, string>, id: string | null): string | null =>
        id === null ? null : (m.get(id) ?? id)

      if (opts.include.profiles) {
        for (const g of parsed.groups) {
          const id = groupIds.get(g.id) ?? g.id
          if (opts.conflict === 'skip' && rowExists('conn_groups', 'id', id)) {
            result.skipped++
            continue
          }
          saveGroup({
            id,
            name: dup ? `${g.name}（导入）` : g.name,
            parentId: mapId(groupIds, g.parentId),
            order: g.order
          })
          result.groups++
        }

        /**
         * 一条凭据引用的处理。
         * duplicate 模式必须换新 ref：否则副本与原连接共用同一条凭据，
         * 删掉任一个都会把另一个的密码一起删掉（deleteProfile 按 ref 删）。
         */
        const takeRef = (ref: string | undefined): string | undefined => {
          if (!ref) return undefined
          const plain = secretMap[ref]
          if (plain === undefined || !vaultOk) return dup ? undefined : ref
          const stored = vault.putSecret(plain, dup ? undefined : ref)
          result.secrets++
          return stored
        }

        /*
         * 代理与私钥**必须排在 profiles 之前** —— 连接引用它们。
         * 它们跟着 profiles 那个开关一起导入（不单独给勾选项）：允许"只导连接不导代理"
         * 就等于允许造出一批指向空气的引用，而那种连接要到连接时才报错。
         */
        for (const x of parsed.proxies) {
          const id = proxyIds.get(x.id) ?? x.id
          if (opts.conflict === 'skip' && rowExists('proxies', 'id', id)) {
            result.skipped++
            continue
          }
          upsertProxy({
            ...x,
            id,
            name: dup ? `${x.name}（导入）` : x.name,
            passwordRef: takeRef(x.passwordRef)
          })
          result.proxies++
        }
        for (const k of parsed.privateKeys) {
          const id = keyIds.get(k.id) ?? k.id
          if (opts.conflict === 'skip' && rowExists('private_keys', 'id', id)) {
            result.skipped++
            continue
          }
          upsertPrivateKey({
            ...k,
            id,
            name: dup ? `${k.name}（导入）` : k.name,
            passphraseRef: takeRef(k.passphraseRef)
          })
          result.privateKeys++
        }

        /** 本次真正写进库的那些，交给 extractInlineRefs 补引用 */
        const imported: ConnectionProfile[] = []
        for (const p of parsed.profiles) {
          const id = profileIds.get(p.id) ?? p.id
          const existing = getProfile(id)
          if (existing && opts.conflict === 'skip') {
            result.skipped++
            continue
          }
          const profile: ConnectionProfile = {
            id,
            name: dup ? `${p.name}（导入）` : p.name,
            groupId: mapId(groupIds, p.groupId),
            color: p.color,
            host: p.host,
            port: p.port,
            username: p.username,
            auth: {
              method: p.auth.method,
              passwordRef: takeRef(p.auth.passwordRef),
              privateKeyId: mapId(keyIds, p.auth.privateKeyId ?? null) ?? undefined,
              // v0.3 及以前的老字段：原样搬进来，随后由 extractInlineRefs 补成引用
              privateKeyPath: p.auth.privateKeyPath,
              passphraseRef: takeRef(p.auth.passphraseRef)
            },
            protocol: p.protocol,
            terminal: p.terminal,
            options: p.options,
            proxyMode: p.proxyMode,
            proxyId: mapId(proxyIds, p.proxyId ?? null) ?? undefined,
            proxy: p.proxy
              ? { ...p.proxy, passwordRef: takeRef(p.proxy.passwordRef) }
              : undefined,
            jumpHostId: p.jumpHostId,
            note: p.note,
            createdAt: existing?.createdAt ?? p.createdAt,
            updatedAt: Date.now(),
            lastUsedAt: p.lastUsedAt ?? existing?.lastUsedAt
          }
          // 覆盖时旧引用若不再被指向，顺手清掉，免得 vault 里留下永远取不到的孤儿条目
          if (existing) {
            const kept = new Set(
              [
                profile.auth.passwordRef,
                profile.auth.passphraseRef,
                profile.proxy?.passwordRef
              ].filter(Boolean) as string[]
            )
            for (const old of [
              existing.auth.passwordRef,
              existing.auth.passphraseRef,
              existing.proxy?.passwordRef
            ]) {
              if (old && !kept.has(old)) vault.deleteSecret(old)
            }
          }
          upsertProfile(profile)
          imported.push(profile)
          result.profiles++
        }

        /*
         * **v0.3 及以前导出的文件**里，代理与私钥是内联在每条连接上的（没有 proxies /
         * privateKeys 两个数组）。不补这一步，导进来的连接就是"直连、没有私钥"——
         * 而且不报错，用户要到第一次连接失败才发现。
         *
         * 走的是与升级迁移**同一个** extractInlineRefs：一份实现，两个调用方。
         * 它会与库里已有的实体去重，所以反复导入同一个老文件也不会堆出一串重复代理。
         */
        const extracted = extractInlineRefs(imported)
        result.proxies += extracted.proxies
        result.privateKeys += extracted.keys
        if (extracted.proxies > 0 || extracted.keys > 0) {
          notes.push(
            `这个文件来自旧版本：已把其中内联的代理与私钥抽成可复用的记录（代理 ${extracted.proxies} 条、私钥 ${extracted.keys} 条），在"设置 → 代理与私钥"里可以改名。`
          )
        }
      }

      if (opts.include.snippets) {
        for (const g of parsed.snippetGroups) {
          const id = snippetGroupIds.get(g.id) ?? g.id
          if (opts.conflict === 'skip' && rowExists('snippet_groups', 'id', id)) {
            result.skipped++
            continue
          }
          saveSnippetGroup({ id, name: dup ? `${g.name}（导入）` : g.name, order: g.order })
        }
        for (const s of parsed.snippets) {
          const id = dup ? randomUUID() : s.id
          if (opts.conflict === 'skip' && rowExists('snippets', 'id', id)) {
            result.skipped++
            continue
          }
          saveSnippet({ ...s, id, groupId: mapId(snippetGroupIds, s.groupId) ?? s.groupId })
          result.snippets++
        }
      }

      // 转发必须排在连接之后：要先确认目标连接真的存在，否则就是指不到人的孤儿规则
      if (opts.include.forwards) {
        for (const f of parsed.forwards) {
          const profileId = mapId(profileIds, f.profileId) ?? f.profileId
          if (!getProfile(profileId)) {
            result.skipped++
            continue
          }
          const id = dup ? randomUUID() : f.id
          if (opts.conflict === 'skip' && rowExists('forwards', 'id', id)) {
            result.skipped++
            continue
          }
          saveForward({ ...f, id, profileId })
          result.forwards++
        }
      }

      if (opts.include.knownHosts) {
        /**
         * 主机指纹只在本机没有该条目时插入，任何冲突策略下都不覆盖。
         * 覆盖一条不一致的指纹等于悄悄替用户吞掉中间人告警 ——
         * 本机记的和文件里写的不一样时，宁可保留本机记录，让 TOFU 该弹就弹。
         */
        const ins = prepare(
          `INSERT INTO known_hosts(key, key_type, fingerprint, added_at)
           VALUES(?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`
        )
        let clashes = 0
        for (const k of parsed.knownHosts) {
          const row = prepare('SELECT fingerprint FROM known_hosts WHERE key = ?').get(k.key) as
            | { fingerprint: string }
            | undefined
          if (row) {
            if (row.fingerprint !== k.fingerprintSha256) clashes++
            result.skipped++
            continue
          }
          ins.run(k.key, k.keyType, k.fingerprintSha256, k.addedAt)
          result.knownHosts++
        }
        if (clashes > 0) {
          notes.push(
            `${clashes} 台主机的指纹与本机记录不一致，已保留本机记录（不覆盖，以免掩盖中间人告警）`
          )
        }
      }
    })
  } finally {
    applying = false
  }

  // 设置放在事务之后：DocStore 有内存缓存，跟着事务回滚会让缓存与库不一致
  if (opts.include.settings && parsed.settings) {
    const { patch, notes: settingNotes } = sanitizeSettings(parsed.settings)
    patchSettings(patch)
    result.settingsApplied = true
    notes.push(...settingNotes)
  }

  pending = null
  log.info(
    `imported ${result.profiles} profiles, ${result.snippets} snippets, ${result.forwards} forwards, ${result.knownHosts} hostkeys, ${result.secrets} secrets (skipped ${result.skipped}, invalid ${result.invalid})`
  )
  return result
}

/** 测试用：清掉暂存槽，避免用例之间互相影响 */
export function resetPendingImport(): void {
  pending = null
  applying = false
}
