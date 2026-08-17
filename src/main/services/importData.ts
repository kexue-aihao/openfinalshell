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
import { encField, tokenize } from '../store/crypto'
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
import { t } from './i18n'
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
  flag: z.string().max(20).optional(),
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

/** scrypt + AES-256-GCM 密文块（v1 的 secrets、v2 的 enc 同形） */
const sealedBlockSchema = z.object({
  kdf: z.literal('scrypt'),
  // 范围卡死：这个数直接决定我们要申请多少内存
  n: z.number().int().min(1 << 12).max(1 << 17),
  salt: z.string().max(200),
  iv: z.string().max(200),
  tag: z.string().max(200),
  cipher: z.string()
})

const dataSchema = z.object({
  settings: z.record(z.string(), z.unknown()).optional(),
  groups: z.array(z.unknown()).default([]),
  profiles: z.array(z.unknown()).default([]),
  snippetGroups: z.array(z.unknown()).default([]),
  snippets: z.array(z.unknown()).default([]),
  forwards: z.array(z.unknown()).default([]),
  knownHosts: z.array(z.unknown()).default([]),
  proxies: z.array(z.unknown()).default([]),
  privateKeys: z.array(z.unknown()).default([])
})

/** v1：明文 data + 可选密码块 */
const envelopeSchema = z.object({
  app: z.literal('openfinalshell'),
  formatVersion: z.number().int().min(1),
  appVersion: z.string().max(60).default(() => t('err.data.unknownVersion')),
  exportedAt: z.number().default(0),
  includesSecrets: z.boolean().default(false),
  data: dataSchema,
  secrets: sealedBlockSchema.optional()
})

/** v2：整文件加密——除信封头外只有一个 enc 密文块 */
const encEnvelopeSchema = z.object({
  app: z.literal('openfinalshell'),
  formatVersion: z.number().int().min(1),
  appVersion: z.string().max(60).default(() => t('err.data.unknownVersion')),
  exportedAt: z.number().default(0),
  includesSecrets: z.boolean().default(false),
  enc: sealedBlockSchema
})

type SealedBlock = z.output<typeof sealedBlockSchema>

/** 分区后的领域数据（v1 在解析时得到；v2 在 apply 用口令解密后才得到） */
interface Partitioned {
  profiles: z.output<typeof profileSchema>[]
  groups: z.output<typeof groupSchema>[]
  snippetGroups: z.output<typeof snippetGroupSchema>[]
  snippets: z.output<typeof snippetSchema>[]
  forwards: z.output<typeof forwardSchema>[]
  knownHosts: z.output<typeof knownHostSchema>[]
  proxies: z.output<typeof savedProxySchema>[]
  privateKeys: z.output<typeof savedKeySchema>[]
  settings?: Record<string, unknown>
  invalid: number
}

interface ParsedImport extends Partitioned {
  appVersion: string
  exportedAt: number
  includesSecrets: boolean
  /** v2 整文件加密：内容尚未解密，等 apply 时用口令解出 */
  encrypted: boolean
  /** v2 的整文件密文块 */
  enc?: SealedBlock
  /** v1 的密码块 */
  secrets?: SealedBlock
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

/** 逐类校验分区（v1 解析时、v2 解密后都走它）。一条坏数据只跳这一条、不废整份文件 */
function partitionData(d: z.output<typeof dataSchema>): Partitioned {
  const profiles = partition(profileSchema, d.profiles)
  const groups = partition(groupSchema, d.groups)
  const snippetGroups = partition(snippetGroupSchema, d.snippetGroups)
  const snippets = partition(snippetSchema, d.snippets)
  const forwards = partition(forwardSchema, d.forwards)
  const knownHosts = partition(knownHostSchema, d.knownHosts)
  const proxies = partition(savedProxySchema, d.proxies)
  const privateKeys = partition(savedKeySchema, d.privateKeys)
  return {
    profiles: profiles.ok,
    groups: groups.ok,
    snippetGroups: snippetGroups.ok,
    snippets: snippets.ok,
    forwards: forwards.ok,
    knownHosts: knownHosts.ok,
    proxies: proxies.ok,
    privateKeys: privateKeys.ok,
    settings: d.settings,
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

const EMPTY_PARTITION: Partitioned = {
  profiles: [],
  groups: [],
  snippetGroups: [],
  snippets: [],
  forwards: [],
  knownHosts: [],
  proxies: [],
  privateKeys: [],
  settings: undefined,
  invalid: 0
}

function parseEnvelope(text: string): ParsedImport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(t('err.data.invalidJson'))
  }
  const head = raw as { app?: unknown; formatVersion?: unknown; enc?: unknown }
  if (head?.app !== 'openfinalshell') {
    throw new Error(t('err.data.notOfsExport'))
  }
  if (typeof head.formatVersion === 'number' && head.formatVersion > EXPORT_FORMAT_VERSION) {
    throw new Error(
      t('err.data.newerFormat', {
        fileVersion: head.formatVersion,
        supportedVersion: EXPORT_FORMAT_VERSION
      })
    )
  }

  // v2 整文件加密：只有一个 enc 块，内容要等 apply 拿到口令才能解密/分区
  if (head.enc !== undefined) {
    const env = encEnvelopeSchema.safeParse(raw)
    if (!env.success) throw new Error(t('err.data.corruptEnvelope'))
    return {
      ...EMPTY_PARTITION,
      appVersion: env.data.appVersion,
      exportedAt: env.data.exportedAt,
      includesSecrets: env.data.includesSecrets,
      encrypted: true,
      enc: env.data.enc
    }
  }

  const env = envelopeSchema.safeParse(raw)
  if (!env.success) {
    throw new Error(t('err.data.corruptEnvelope'))
  }
  return {
    ...partitionData(env.data.data),
    appVersion: env.data.appVersion,
    exportedAt: env.data.exportedAt,
    includesSecrets: env.data.includesSecrets && env.data.secrets !== undefined,
    encrypted: false,
    secrets: env.data.secrets
  }
}

// ---------------------------------------------------------------------------
// 第一步：选文件 + 解析，暂存等用户确认
// ---------------------------------------------------------------------------

interface Pending {
  token: string
  path: string
  parsed: ParsedImport
  /**
   * 已解出的密码明文映射（局域网接收路径：收到那一刻就持有通道密钥，当场解密）。
   * 存在时 applyImport 直接采用、不再要求口令。文件导入路径恒为 undefined。
   */
  secretMap?: Record<string, string>
}

/** 单槽暂存：renderer 只持有 token，不接触文件路径，也不会重复读盘（避免 TOCTOU） */
let pending: Pending | null = null
let applying = false

export async function inspectImport(opts: { sourcePath?: string } = {}): Promise<ImportPreview | null> {
  let source = opts.sourcePath
  if (!source) {
    const r = await dialog.showOpenDialog({
      title: t('err.data.importTitle'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    source = r.filePaths[0]
  }

  const info = await stat(source)
  if (info.size > MAX_IMPORT_BYTES) {
    throw new Error(t('err.data.fileTooLarge', { size: Math.round(info.size / 1024 / 1024) }))
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
    // v2 整文件加密：条目数要解密后才知道，这里先报 0，界面据此提示"输入口令后导入"
    encrypted: parsed.encrypted,
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

/** 用口令解开一个密文块，返回明文字符串。GCM 校验失败一律归为"口令不对"（含文件被改） */
function openSealedString(sealed: SealedBlock, passphrase: string): string {
  const key = scryptSync(passphrase, Buffer.from(sealed.salt, 'base64'), SCRYPT_KEYLEN, {
    N: sealed.n,
    r: 8,
    p: 1,
    maxmem: SCRYPT_MAXMEM
  })
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  try {
    return Buffer.concat([
      d.update(Buffer.from(sealed.cipher, 'base64')),
      d.final()
    ]).toString('utf8')
  } catch {
    // GCM 校验失败：口令不对，或文件被改过 —— 两者无法区分，一起说
    throw new Error(t('err.data.wrongPassphrase'))
  }
}

function openSecrets(sealed: SealedBlock, passphrase: string): Record<string, string> {
  const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(openSealedString(sealed, passphrase)))
  if (!parsed.success) throw new Error(t('err.data.badSecretsFormat'))
  return parsed.data
}

/**
 * 解开 v2 整文件加密块：口令 → {分区后的领域数据, 密码明文映射}。
 * 两个调用方：applyImport（文件导入，apply 时才拿到用户口令）与
 * inspectImportFromText（局域网接收，收到那一刻就持有通道密钥）——
 * 各写一遍的话，解密与结构校验的语义迟早分叉（extractInlineRefs 同哲学）。
 */
function openEncryptedEnvelope(
  enc: SealedBlock,
  passphrase: string
): { resolved: Partitioned; secretMap: Record<string, string> } {
  let obj: unknown
  try {
    obj = JSON.parse(openSealedString(enc, passphrase))
  } catch (err) {
    // openSealedString 的 wrongPassphrase 直接抛；JSON.parse 失败也归为文件损坏/口令错
    if (err instanceof Error && err.message === t('err.data.wrongPassphrase')) throw err
    throw new Error(t('err.data.corruptEnvelope'))
  }
  const shape = z
    .object({ data: dataSchema, secrets: z.record(z.string(), z.string()).optional() })
    .safeParse(obj)
  if (!shape.success) throw new Error(t('err.data.corruptEnvelope'))
  return { resolved: partitionData(shape.data.data), secretMap: shape.data.secrets ?? {} }
}

/**
 * 从内存文本进入导入预览（局域网同步接收专用；文件导入走 inspectImport）。
 *
 * 与文件路径的两点不同：
 * - **就地解密**：调用方（LanSyncManager）此刻就持有配对派生的通道密钥，立即解出
 *   真实计数给确认框 —— 文件导入的 v2 要等用户输口令，所以那边 counts 先报 0。
 * - 解出的密码明文映射存进 pending.secretMap，apply 时直接采用、不再要求口令。
 *
 * ⚠️ pending 是**单槽**：这里写入会顶掉进行中的文件导入预览（反之亦然）。旧 token 的
 * apply 会落在 importSessionExpiredFile 上 —— 安全，只是体验上"预览过期"。共用一槽是
 * 刻意的：两个导入流本就不该并行，第二个槽只会让"哪份数据正要进库"变得说不清。
 * applying 期间一律拒绝换底（apply 读的就是 pending，中途换底等于换掉正在写的数据源）。
 */
export function inspectImportFromText(
  text: string,
  opts: { source: string; passphrase?: string }
): ImportPreview {
  if (applying) throw new Error(t('err.data.importInProgress'))
  const bytes = Buffer.byteLength(text, 'utf8')
  // 帧层已按 MAX_FRAME_BYTES 挡过一次，这里是第二道（两个常量对齐，防有人只改一处）
  if (bytes > MAX_IMPORT_BYTES) {
    throw new Error(t('err.data.fileTooLarge', { size: Math.round(bytes / 1024 / 1024) }))
  }
  let parsed = parseEnvelope(text)
  let secretMap: Record<string, string> | undefined
  if (parsed.encrypted && opts.passphrase) {
    const opened = openEncryptedEnvelope(parsed.enc!, opts.passphrase)
    secretMap = opened.secretMap
    // 换成解密后的分区数据；encrypted 归 false —— 对 applyImport 而言它已经是明文了
    parsed = {
      ...opened.resolved,
      appVersion: parsed.appVersion,
      exportedAt: parsed.exportedAt,
      includesSecrets: parsed.includesSecrets,
      encrypted: false
    }
  }
  const conflicts = parsed.profiles.filter((p) => getProfile(p.id) !== undefined).length
  pending = { token: randomUUID(), path: opts.source, parsed, secretMap }
  log.info(
    `lan import preview from ${opts.source}: ${parsed.profiles.length} profiles, invalid=${parsed.invalid}`
  )
  return {
    token: pending.token,
    source: 'lan',
    path: opts.source,
    appVersion: parsed.appVersion,
    exportedAt: parsed.exportedAt,
    includesSecrets: parsed.includesSecrets,
    encrypted: parsed.encrypted,
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
  if ('window' in raw) notes.push(t('err.data.windowStateKept'))

  const sftp = patch.sftp as Record<string, unknown> | undefined
  if (sftp && typeof sftp.downloadDir === 'string' && sftp.downloadDir !== '') {
    if (!existsSync(sftp.downloadDir)) {
      notes.push(t('err.data.downloadDirMissing', { dir: sftp.downloadDir }))
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
    notes.push(t('err.data.settingsStripped', { keys: guarded.stripped.join('、') }))
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
    throw new Error(t('err.data.importSessionExpiredFile'))
  }
  if (applying) throw new Error(t('err.data.importInProgress'))

  const { parsed } = pending
  const dup = opts.conflict === 'duplicate'
  const notes: string[] = []

  // 口令先验证再动库：口令输错是最常见的失败，不该让用户重新选一遍文件
  let resolved: Partitioned = parsed
  // 局域网接收路径在 inspect 时已解密，密码映射躺在 pending 里，不再要求口令
  let secretMap: Record<string, string> = pending.secretMap ?? {}
  if (parsed.encrypted) {
    // v2 整文件加密：口令既解密整包、也带出密码明文映射
    if (!opts.passphrase) throw new Error(t('err.data.passphraseRequired'))
    const opened = openEncryptedEnvelope(parsed.enc!, opts.passphrase)
    resolved = opened.resolved
    secretMap = opened.secretMap
  } else if (parsed.secrets && opts.passphrase) {
    secretMap = openSecrets(parsed.secrets, opts.passphrase)
  } else if (parsed.secrets && opts.include.profiles) {
    notes.push(t('err.data.noPassphraseSecrets'))
  }

  const vaultOk = Object.keys(secretMap).length === 0 || vault.isAvailable()
  if (!vaultOk) {
    notes.push(t('err.data.vaultUnavailable'))
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
    invalid: resolved.invalid,
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
        for (const g of resolved.groups) groupIds.set(g.id, randomUUID())
        for (const p of resolved.profiles) profileIds.set(p.id, randomUUID())
        // 不预分配的话，副本连接会指回**原来那条**代理/私钥
        for (const x of resolved.proxies) proxyIds.set(x.id, randomUUID())
        for (const k of resolved.privateKeys) keyIds.set(k.id, randomUUID())
        for (const g of resolved.snippetGroups) snippetGroupIds.set(g.id, randomUUID())
      }
      const mapId = (m: Map<string, string>, id: string | null): string | null =>
        id === null ? null : (m.get(id) ?? id)

      if (opts.include.profiles) {
        for (const g of resolved.groups) {
          const id = groupIds.get(g.id) ?? g.id
          if (opts.conflict === 'skip' && rowExists('conn_groups', 'id', id)) {
            result.skipped++
            continue
          }
          saveGroup({
            id,
            name: dup ? t('err.data.importedNameSuffix', { name: g.name }) : g.name,
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
        for (const x of resolved.proxies) {
          const id = proxyIds.get(x.id) ?? x.id
          if (opts.conflict === 'skip' && rowExists('proxies', 'id', id)) {
            result.skipped++
            continue
          }
          upsertProxy({
            ...x,
            id,
            name: dup ? t('err.data.importedNameSuffix', { name: x.name }) : x.name,
            passwordRef: takeRef(x.passwordRef)
          })
          result.proxies++
        }
        for (const k of resolved.privateKeys) {
          const id = keyIds.get(k.id) ?? k.id
          if (opts.conflict === 'skip' && rowExists('private_keys', 'id', id)) {
            result.skipped++
            continue
          }
          upsertPrivateKey({
            ...k,
            id,
            name: dup ? t('err.data.importedNameSuffix', { name: k.name }) : k.name,
            passphraseRef: takeRef(k.passphraseRef)
          })
          result.privateKeys++
        }

        /** 本次真正写进库的那些，交给 extractInlineRefs 补引用 */
        const imported: ConnectionProfile[] = []
        for (const p of resolved.profiles) {
          const id = profileIds.get(p.id) ?? p.id
          const existing = getProfile(id)
          if (existing && opts.conflict === 'skip') {
            result.skipped++
            continue
          }
          const profile: ConnectionProfile = {
            id,
            name: dup ? t('err.data.importedNameSuffix', { name: p.name }) : p.name,
            groupId: mapId(groupIds, p.groupId),
            color: p.color,
            flag: p.flag,
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
            t('err.data.inlineRefsExtracted', {
              proxies: extracted.proxies,
              keys: extracted.keys
            })
          )
        }
      }

      if (opts.include.snippets) {
        for (const g of resolved.snippetGroups) {
          const id = snippetGroupIds.get(g.id) ?? g.id
          if (opts.conflict === 'skip' && rowExists('snippet_groups', 'id', id)) {
            result.skipped++
            continue
          }
          saveSnippetGroup({
            id,
            name: dup ? t('err.data.importedNameSuffix', { name: g.name }) : g.name,
            order: g.order
          })
        }
        for (const s of resolved.snippets) {
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
        for (const f of resolved.forwards) {
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
        // key 存决定论 token（等值查找），明文规范键加密进 host_enc（与 hostkeys.ts 一致）
        const ins = prepare(
          `INSERT INTO known_hosts(key, key_type, fingerprint, added_at, host_enc)
           VALUES(?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`
        )
        let clashes = 0
        for (const k of resolved.knownHosts) {
          const token = tokenize(k.key)
          const row = prepare('SELECT fingerprint FROM known_hosts WHERE key = ?').get(token) as
            | { fingerprint: string }
            | undefined
          if (row) {
            if (row.fingerprint !== k.fingerprintSha256) clashes++
            result.skipped++
            continue
          }
          ins.run(token, k.keyType, k.fingerprintSha256, k.addedAt, encField(k.key))
          result.knownHosts++
        }
        if (clashes > 0) {
          notes.push(t('err.data.hostKeyClashes', { count: clashes }))
        }
      }
    })
  } finally {
    applying = false
  }

  // 设置放在事务之后：DocStore 有内存缓存，跟着事务回滚会让缓存与库不一致
  if (opts.include.settings && resolved.settings) {
    const { patch, notes: settingNotes } = sanitizeSettings(resolved.settings)
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
