import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { app, dialog } from 'electron'
import type { AppSettings, ConnectionProfile } from '@shared/types'
import { prepare } from '../store/Database'
import { decField } from '../store/crypto'
import { vault } from '../store/Vault'
import { getSettings } from './settings'
import { t } from './i18n'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('export')

/**
 * 导入侧能接受的最高格式版本。
 * - v1：`data` 明文 + 可选 `secrets` 密码块（默认导出）。
 * - v2：整个 `{data, secrets}` 用导出口令加密进 `enc` 块，文件里无任何明文（整文件加密导出）。
 */
export const EXPORT_FORMAT_VERSION = 2

/** scrypt 参数：N=2^15 在本机约 100ms 量级，够挡离线爆破又不至于卡界面 */
const SCRYPT_N = 32768
const SCRYPT_KEYLEN = 32
/**
 * 必须显式给 maxmem：N=32768、r=8 需要 128*N*r = 32MiB，正好顶到 Node 的默认上限，
 * 不给就直接抛 "memory limit exceeded"（勾选含密码导出必然失败）。
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024

export interface ExportOptions {
  /** 是否连已保存的密码一起导出（必须提供导出口令） */
  includeSecrets: boolean
  /**
   * 整文件加密导出：连主机/用户名等**配置**也一起加密，文件里无任何明文（formatVersion 2）。
   * 同样必须提供导出口令（口令既解密数据、也是密码块的密钥）。
   */
  encryptAll?: boolean
  passphrase?: string
  /** 不弹保存对话框，直接写这个路径（测试用） */
  targetPath?: string
}

export interface ExportResult {
  path: string
  bytes: number
  profiles: number
  secrets: number
}

/** scrypt + AES-256-GCM 封出来的密文块（密码块 secrets、整文件加密块 enc 同形） */
interface SealedBlock {
  kdf: 'scrypt'
  n: number
  salt: string
  iv: string
  tag: string
  cipher: string
}

interface ExportData {
  settings: AppSettings
  groups: unknown[]
  profiles: ConnectionProfile[]
  snippetGroups: unknown[]
  snippets: unknown[]
  forwards: unknown[]
  knownHosts: unknown[]
  /** 可复用的代理与私钥（v0.4 起）。连接按 id 引用它们，所以必须一起导出 */
  proxies: unknown[]
  privateKeys: unknown[]
}

interface Envelope {
  app: 'openfinalshell'
  formatVersion: number
  appVersion: string
  exportedAt: number
  includesSecrets: boolean
  /** 明确写给人看的说明，避免误以为里面有明文密码 */
  note: string
  /** v1：明文数据；v2 用 enc 承载、这里省略 */
  data?: ExportData
  /** v1 的密码块 */
  secrets?: SealedBlock
  /** v2：整个 {data, secrets(明文 ref→plain 映射)} 加密后的块 */
  enc?: SealedBlock
}

/**
 * 收集全库数据。**导出内容一律解密成明文**——at-rest 的密文绑定本机 DPAPI，不可移植；
 * 导出要么明文（v1）、要么用导出口令重新加密（v2），都从这里的明文出发（与 sealSecrets
 * 把 Vault 密文重解成明文再封是同一条取舍）。
 */
function collect(): ExportData {
  const rows = <T>(sql: string): T[] => prepare(sql).all() as T[]
  const json = <T>(sql: string): T[] =>
    (prepare(sql).all() as Array<{ json: string }>).map((r) => JSON.parse(decField(r.json)) as T)

  return {
    settings: getSettings(),
    groups: rows<{ id: string; name: string; parent_id: string | null; sort_order: number }>(
      'SELECT id, name, parent_id, sort_order FROM conn_groups ORDER BY sort_order'
    ).map((g) => ({ id: g.id, name: decField(g.name), parentId: g.parent_id, order: g.sort_order })),
    profiles: json<ConnectionProfile>('SELECT json FROM profiles ORDER BY created_at'),
    snippetGroups: rows<{ id: string; name: string; sort_order: number }>(
      'SELECT id, name, sort_order FROM snippet_groups ORDER BY sort_order'
    ).map((g) => ({ id: g.id, name: decField(g.name), order: g.sort_order })),
    snippets: json('SELECT json FROM snippets ORDER BY sort_order'),
    proxies: json('SELECT json FROM proxies ORDER BY created_at'),
    privateKeys: json('SELECT json FROM private_keys ORDER BY created_at'),
    forwards: json('SELECT json FROM forwards'),
    // key 列现在是决定论 token；导出的是可移植的明文 "host:port:keyType"（老行 host_enc 为空时回落 key）
    knownHosts: rows<{
      key: string
      key_type: string
      fingerprint: string
      added_at: number
      host_enc: string | null
    }>('SELECT key, key_type, fingerprint, added_at, host_enc FROM known_hosts').map((k) => ({
      key: k.host_enc != null ? decField(k.host_enc) : k.key,
      keyType: k.key_type,
      fingerprintSha256: k.fingerprint,
      addedAt: k.added_at
    }))
  }
}

/**
 * 用导出口令把一段明文封成 scrypt + AES-256-GCM 密文块。
 * 密码块（v1 的 secrets）与整文件加密块（v2 的 enc）共用它。
 */
function sealString(plaintext: string, passphrase: string): SealedBlock {
  const salt = randomBytes(16)
  const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: 8,
    p: 1,
    maxmem: SCRYPT_MAXMEM
  })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    kdf: 'scrypt',
    n: SCRYPT_N,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    cipher: enc.toString('base64')
  }
}

/**
 * 把 Vault 里的密码解出来成 {ref: 明文} 映射。
 * 不能直接搬 vault 里的密文：那是 DPAPI 加密的，绑定当前 Windows 账户，
 * 换机或重装系统后根本解不开，搬过去等于导出了一堆废数据。
 */
function collectSecrets(refs: string[]): Record<string, string> {
  const plain: Record<string, string> = {}
  for (const ref of refs) {
    const value = vault.getSecret(ref)
    if (value !== null) plain[ref] = value
  }
  return plain
}

/** v1 密码块：{ref: 明文} 用导出口令封装 */
function sealSecrets(refs: string[], passphrase: string): SealedBlock {
  return sealString(JSON.stringify(collectSecrets(refs)), passphrase)
}

/** 收集所有被引用到的 secret ref（只导出真正在用的，不搬孤儿条目） */
function referencedRefs(data: ExportData): string[] {
  const refs = new Set<string>()
  for (const p of data.profiles) {
    if (p.auth.passwordRef) refs.add(p.auth.passwordRef)
    // 迁移前的老字段也扫一遍：库里可能还留着（迁移刻意不删旧字段）
    if (p.auth.passphraseRef) refs.add(p.auth.passphraseRef)
    if (p.proxy?.passwordRef) refs.add(p.proxy.passwordRef)
  }
  /*
   * ⚠️ 代理密码与私钥口令现在归**独立实体**，不再挂在 profile 上。
   * 漏扫这两张表的后果是"勾了含密码导出，但代理密码与私钥口令一条都没进文件"——
   * 而且不会有任何报错，用户到换机导入那天才发现。
   */
  for (const x of data.proxies as Array<{ passwordRef?: string }>) {
    if (x.passwordRef) refs.add(x.passwordRef)
  }
  for (const k of data.privateKeys as Array<{ passphraseRef?: string }>) {
    if (k.passphraseRef) refs.add(k.passphraseRef)
  }
  return [...refs]
}

function defaultFileName(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `openfinalshell-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`
}

/**
 * 构造一份完整的导出信封（JSON 文本）。**不落盘、不弹对话框** ——
 * 文件导出与局域网同步共用这一份构造：同步线上传的就是标准 v2 信封，
 * 只是 seal 口令换成配对派生密钥（见 lansync/pairing.channelPass）。
 * 两条路各写一遍的话，"文件里的"与"线上发的"迟早不是同一种文件。
 *
 * 口令的**长度**校验留在 exportData()（那是对用户输入的要求；派生密钥恒 43 字符），
 * 这里只保留"需要口令却没给"的防御性断言。
 */
export function buildExportEnvelope(opts: {
  includeSecrets: boolean
  encryptAll?: boolean
  passphrase?: string
}): { text: string; bytes: number; profiles: number; secrets: number } {
  if ((opts.includeSecrets || opts.encryptAll) && !opts.passphrase) {
    throw new Error(t('err.data.passphraseRequired'))
  }
  const data = collect()
  const refs = referencedRefs(data)
  let envelope: Envelope
  if (opts.encryptAll) {
    // 整个 {data, secrets(明文映射)} 一起加密——文件里除信封头外无任何明文
    const blob = JSON.stringify({
      data,
      secrets: opts.includeSecrets ? collectSecrets(refs) : undefined
    })
    envelope = {
      app: 'openfinalshell',
      formatVersion: 2,
      appVersion: app.getVersion(),
      exportedAt: Date.now(),
      includesSecrets: opts.includeSecrets,
      note: t('err.data.exportNoteEncrypted'),
      enc: sealString(blob, opts.passphrase!)
    }
  } else {
    envelope = {
      app: 'openfinalshell',
      formatVersion: 1,
      appVersion: app.getVersion(),
      exportedAt: Date.now(),
      includesSecrets: opts.includeSecrets,
      note: opts.includeSecrets
        ? t('err.data.exportNoteWithSecrets')
        : t('err.data.exportNoteNoSecrets'),
      data,
      secrets: opts.includeSecrets ? sealSecrets(refs, opts.passphrase!) : undefined
    }
  }
  const text = JSON.stringify(envelope, null, 2)
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    profiles: data.profiles.length,
    secrets: opts.includeSecrets ? refs.length : 0
  }
}

export async function exportData(opts: ExportOptions): Promise<ExportResult | null> {
  // v2 整文件加密与 v1 含密码导出都需要口令
  const needsPass = opts.includeSecrets || opts.encryptAll
  if (needsPass && !opts.passphrase) {
    throw new Error(t('err.data.passphraseRequired'))
  }
  if (needsPass && (opts.passphrase ?? '').length < 8) {
    throw new Error(t('err.data.passphraseTooShort'))
  }

  let target = opts.targetPath
  if (!target) {
    const r = await dialog.showSaveDialog({
      title: t('err.data.exportTitle'),
      defaultPath: defaultFileName(),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return null
    target = r.filePath
  }

  const built = buildExportEnvelope(opts)
  await fs.writeFile(target, built.text, 'utf8')
  log.info(
    `exported ${built.profiles} profiles to ${target} (secrets: ${opts.includeSecrets ? built.secrets : 'none'})`
  )
  return { path: target, bytes: built.bytes, profiles: built.profiles, secrets: built.secrets }
}
