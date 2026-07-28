import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { app, dialog } from 'electron'
import type { AppSettings, ConnectionProfile } from '@shared/types'
import { prepare } from '../store/Database'
import { vault } from '../store/Vault'
import { getSettings } from './settings'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('export')

export const EXPORT_FORMAT_VERSION = 1

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

interface Envelope {
  app: 'openfinalshell'
  formatVersion: number
  appVersion: string
  exportedAt: number
  includesSecrets: boolean
  /** 明确写给人看的说明，避免误以为里面有明文密码 */
  note: string
  data: {
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
  secrets?: {
    kdf: 'scrypt'
    n: number
    salt: string
    iv: string
    tag: string
    cipher: string
  }
}

function collect(): Envelope['data'] {
  const rows = <T>(sql: string): T[] => prepare(sql).all() as T[]
  const json = <T>(sql: string): T[] =>
    (prepare(sql).all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as T)

  return {
    settings: getSettings(),
    groups: rows<{ id: string; name: string; parent_id: string | null; sort_order: number }>(
      'SELECT id, name, parent_id, sort_order FROM conn_groups ORDER BY sort_order, name'
    ).map((g) => ({ id: g.id, name: g.name, parentId: g.parent_id, order: g.sort_order })),
    profiles: json<ConnectionProfile>('SELECT json FROM profiles ORDER BY created_at'),
    snippetGroups: rows<{ id: string; name: string; sort_order: number }>(
      'SELECT id, name, sort_order FROM snippet_groups ORDER BY sort_order, name'
    ).map((g) => ({ id: g.id, name: g.name, order: g.sort_order })),
    snippets: json('SELECT json FROM snippets ORDER BY sort_order'),
    proxies: json('SELECT json FROM proxies ORDER BY created_at'),
    privateKeys: json('SELECT json FROM private_keys ORDER BY created_at'),
    forwards: json('SELECT json FROM forwards'),
    knownHosts: rows<{
      key: string
      key_type: string
      fingerprint: string
      added_at: number
    }>('SELECT key, key_type, fingerprint, added_at FROM known_hosts').map((k) => ({
      key: k.key,
      keyType: k.key_type,
      fingerprintSha256: k.fingerprint,
      addedAt: k.added_at
    }))
  }
}

/**
 * 把 Vault 里的密码解出来，用导出口令重新加密成一个信封。
 *
 * 不能直接搬 vault 里的密文：那是 DPAPI 加密的，绑定当前 Windows 账户，
 * 换机或重装系统后根本解不开，搬过去等于导出了一堆废数据。
 */
function sealSecrets(refs: string[], passphrase: string): Envelope['secrets'] {
  const plain: Record<string, string> = {}
  for (const ref of refs) {
    const value = vault.getSecret(ref)
    if (value !== null) plain[ref] = value
  }
  const salt = randomBytes(16)
  const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: 8,
    p: 1,
    maxmem: SCRYPT_MAXMEM
  })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(plain), 'utf8'),
    cipher.final()
  ])
  return {
    kdf: 'scrypt',
    n: SCRYPT_N,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    cipher: enc.toString('base64')
  }
}

/** 收集所有被引用到的 secret ref（只导出真正在用的，不搬孤儿条目） */
function referencedRefs(data: Envelope['data']): string[] {
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

export async function exportData(opts: ExportOptions): Promise<ExportResult | null> {
  if (opts.includeSecrets && !opts.passphrase) {
    throw new Error('导出已保存的密码必须设置导出口令')
  }
  if (opts.includeSecrets && (opts.passphrase ?? '').length < 8) {
    throw new Error('导出口令至少 8 位')
  }

  let target = opts.targetPath
  if (!target) {
    const r = await dialog.showSaveDialog({
      title: '导出应用数据',
      defaultPath: defaultFileName(),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return null
    target = r.filePath
  }

  const data = collect()
  const refs = referencedRefs(data)
  const envelope: Envelope = {
    app: 'openfinalshell',
    formatVersion: EXPORT_FORMAT_VERSION,
    appVersion: app.getVersion(),
    exportedAt: Date.now(),
    includesSecrets: opts.includeSecrets,
    note: opts.includeSecrets
      ? '密码已用导出口令加密（scrypt + AES-256-GCM）存放在 secrets 段，口令丢失无法恢复。'
      : '本文件不含任何密码。profiles 里的 passwordRef 只是引用 id，导入后需重新填写密码。',
    data,
    secrets: opts.includeSecrets ? sealSecrets(refs, opts.passphrase!) : undefined
  }

  const text = JSON.stringify(envelope, null, 2)
  await fs.writeFile(target, text, 'utf8')
  log.info(
    `exported ${data.profiles.length} profiles to ${target} (secrets: ${opts.includeSecrets ? refs.length : 'none'})`
  )
  return {
    path: target,
    bytes: Buffer.byteLength(text, 'utf8'),
    profiles: data.profiles.length,
    secrets: opts.includeSecrets ? refs.length : 0
  }
}
