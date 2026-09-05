import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  ConnectionProfile,
  DeleteRefResult,
  PrivateKeyId,
  ProxyId,
  SavedPrivateKey,
  SavedPrivateKeyDraft,
  SavedProxy,
  SavedProxyDraft
} from '@shared/types'
import { prepare, tx } from './Database'
import { decField, encField, tryDecJson } from './crypto'
import { vault } from './Vault'
import { t } from '../services/i18n'
import { expandPath } from '../utils/expandPath'

/**
 * 「已保存的代理」与「已保存的私钥」——两类**被连接引用**的实体。
 *
 * 两者放同一个文件，因为它们的形状与规矩逐条相同（一张表、一个 Vault 引用、
 * 删除前要查谁在用），分成两个文件就会有两份"删除前检查引用"的实现，
 * 而这个项目里同一件事有两份实现历来是出问题的地方。
 *
 * ---
 *
 * 三条贯穿本文件的规矩：
 *
 * 1. **明文口令只单向进来**。`save*` 收的是 Draft（明文），返回的实体只带 Vault 引用；
 *    空串与 `undefined` 都是"保持原值"，要清掉得显式 `clearSecret`——
 *    与 `connections.ts` 的 `saveProfile` 完全一致。
 * 2. **删除前先查引用**，被引用就不删并回报是哪几台机器（`DeleteRefResult`）。
 *    库里没有 FOREIGN KEY，这一层是唯一的引用完整性保障。
 * 3. **删除时才清 Vault 条目**。反过来说：删连接**不许**清这两类实体的密码 ——
 *    它们是共享的，删一台机器把别人的代理密码带走是这次改造最容易引进的 bug
 *    （`connections.ts` 的 `deleteProfile` 里有一段注释专门守这个）。
 */

// ---------------------------------------------------------------------------
// 共用：引用扫描
// ---------------------------------------------------------------------------

/** 遍历 profiles 的 JSON 列。两类实体的引用检查都要走它，所以只写一遍 */
function allProfiles(): ConnectionProfile[] {
  // 逐行解密、跳过解不开的行（换机 key 丢失时的引用扫描不该整个抛错）
  return (prepare('SELECT json FROM profiles').all() as Array<{ json: string }>)
    .map((r) => tryDecJson<ConnectionProfile>(r.json))
    .filter((p): p is ConnectionProfile => p !== null)
}

/** 谁在用这条代理 —— 返回连接名（给确认框看的，不是 id） */
export function proxyUsedBy(id: ProxyId): string[] {
  return allProfiles()
    .filter((p) => p.proxyId === id)
    .map((p) => p.name)
}

export function keyUsedBy(id: PrivateKeyId): string[] {
  return allProfiles()
    .filter((p) => p.auth.privateKeyId === id)
    .map((p) => p.name)
}

// ---------------------------------------------------------------------------
// 代理
// ---------------------------------------------------------------------------

export function listProxies(): SavedProxy[] {
  // name 列可能已加密，改按 created_at 取回后在 JS 里按 name 排（name 在 json 里，解密后可得）；
  // 逐行解密、跳过解不开的行
  return (prepare('SELECT json FROM proxies ORDER BY created_at').all() as Array<{ json: string }>)
    .map((r) => tryDecJson<SavedProxy>(r.json))
    .filter((p): p is SavedProxy => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt)
}

export function getProxy(id: ProxyId): SavedProxy | undefined {
  const row = prepare('SELECT json FROM proxies WHERE id = ?').get(id) as
    | { json: string }
    | undefined
  return row ? (JSON.parse(decField(row.json)) as SavedProxy) : undefined
}

/** 导出为了给导入与迁移用：那两边不该再抄一份与表结构耦合的 SQL */
export function upsertProxy(p: SavedProxy): void {
  prepare(
    `INSERT INTO proxies(id, name, json, created_at, updated_at) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, json = excluded.json,
                                   updated_at = excluded.updated_at`
  ).run(p.id, encField(p.name), encField(JSON.stringify(p)), p.createdAt, p.updatedAt)
}

export function saveProxy(draft: SavedProxyDraft): SavedProxy {
  const now = Date.now()
  return tx(() => {
    const existing = draft.id ? getProxy(draft.id) : undefined
    let passwordRef = existing?.passwordRef

    if (draft.clearSecret) {
      vault.deleteSecret(passwordRef)
      passwordRef = undefined
    }
    if (draft.password !== undefined && draft.password !== '') {
      passwordRef = vault.putSecretIfAvailable(draft.password, passwordRef)
    }

    const proxy: SavedProxy = {
      id: existing?.id ?? randomUUID(),
      name: draft.name.trim(),
      type: draft.type,
      host: draft.host.trim(),
      port: draft.port,
      username: draft.username?.trim() || undefined,
      passwordRef,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    upsertProxy(proxy)
    return proxy
  })
}

export function deleteProxy(id: ProxyId): DeleteRefResult {
  return tx(() => {
    const usedBy = proxyUsedBy(id)
    if (usedBy.length > 0) return { deleted: false, usedBy }
    vault.deleteSecret(getProxy(id)?.passwordRef)
    prepare('DELETE FROM proxies WHERE id = ?').run(id)
    return { deleted: true }
  })
}

// ---------------------------------------------------------------------------
// 私钥
// ---------------------------------------------------------------------------

/** 仅存在于 main 内存里的外部私钥文件快照，绝不经 IPC 回传。 */
export interface PrivateKeySource {
  bytes: Buffer
  fingerprint: string
}

function fingerprintPrivateKey(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 读取当前路径的私钥，以便保存副本或记录盘符重绑定所需的指纹。
 * `required=false` 时保留旧的"路径可以先填、连接时再报错"行为。
 */
export async function readPrivateKeySource(
  path: string,
  required: boolean
): Promise<PrivateKeySource | undefined> {
  const expanded = expandPath(path.trim())
  try {
    const bytes = await readFile(expanded)
    return { bytes, fingerprint: fingerprintPrivateKey(bytes) }
  } catch {
    if (!required) return undefined
    throw new Error(t('err.ssh.privateKeyReadFail', { name: path.trim(), path: expanded }))
  }
}

export function listPrivateKeys(): SavedPrivateKey[] {
  // 同 listProxies：name 列可能已加密，按 created_at 取回后在 JS 里按 name 排
  return (
    prepare('SELECT json FROM private_keys ORDER BY created_at').all() as Array<{ json: string }>
  )
    .map((r) => tryDecJson<SavedPrivateKey>(r.json))
    .filter((k): k is SavedPrivateKey => k !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt)
}

export function getPrivateKey(id: PrivateKeyId): SavedPrivateKey | undefined {
  const row = prepare('SELECT json FROM private_keys WHERE id = ?').get(id) as
    | { json: string }
    | undefined
  return row ? (JSON.parse(decField(row.json)) as SavedPrivateKey) : undefined
}

export function upsertPrivateKey(k: SavedPrivateKey): void {
  prepare(
    `INSERT INTO private_keys(id, name, json, created_at, updated_at) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, json = excluded.json,
                                   updated_at = excluded.updated_at`
  ).run(k.id, encField(k.name), encField(JSON.stringify(k)), k.createdAt, k.updatedAt)
}

export function savePrivateKey(
  draft: SavedPrivateKeyDraft,
  source?: PrivateKeySource
): SavedPrivateKey {
  const now = Date.now()
  return tx(() => {
    const existing = draft.id ? getPrivateKey(draft.id) : undefined
    let passphraseRef = existing?.passphraseRef
    let materialRef = existing?.materialRef

    if (draft.clearSecret) {
      vault.deleteSecret(passphraseRef)
      passphraseRef = undefined
    }
    if (draft.passphrase !== undefined && draft.passphrase !== '') {
      passphraseRef = vault.putSecretIfAvailable(draft.passphrase, passphraseRef)
    }

    if (draft.clearManagedCopy) {
      vault.deleteSecret(materialRef)
      materialRef = undefined
    }
    if (draft.storeManagedCopy) {
      // 调用方必须已在 main 进程从选定路径读到文件；不接受 renderer 传来的内容。
      if (!source) throw new Error(t('err.ssh.privateKeyReadFail', { name: draft.name, path: draft.path }))
      materialRef = vault.putSecret(source.bytes.toString('base64'), materialRef)
    }

    const path = draft.path.trim()
    // A managed copy is bound to the path it was read from. If the path
    // changes without explicitly refreshing the copy, retaining the old
    // material would make a missing new path silently authenticate with the
    // previous file's key.
    if (existing && existing.path !== path && !draft.storeManagedCopy && materialRef) {
      vault.deleteSecret(materialRef)
      materialRef = undefined
    }
    // 路径改了却读不到新文件时，旧文件的指纹不能再拿来冒充新路径。
    const sourceFingerprint = source?.fingerprint ?? (existing?.path === path ? existing.sourceFingerprint : undefined)

    const key: SavedPrivateKey = {
      id: existing?.id ?? randomUUID(),
      name: draft.name.trim(),
      path,
      passphraseRef,
      materialRef,
      sourceFingerprint,
      note: draft.note?.trim() || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    upsertPrivateKey(key)
    return key
  })
}

/** IPC 保存入口：从路径读取只发生在 main，私钥内容永远不会穿过 IPC。 */
export async function savePrivateKeyFromDraft(draft: SavedPrivateKeyDraft): Promise<SavedPrivateKey> {
  const source = await readPrivateKeySource(draft.path, draft.storeManagedCopy === true)
  return savePrivateKey(draft, source)
}

/** 盘符重绑定成功后，只更新本机的外部来源位置与对应指纹。 */
export function updatePrivateKeySource(
  id: PrivateKeyId,
  path: string,
  sourceFingerprint: string
): void {
  const existing = getPrivateKey(id)
  if (!existing) return
  if (existing.path === path && existing.sourceFingerprint === sourceFingerprint) return
  upsertPrivateKey({ ...existing, path, sourceFingerprint, updatedAt: Date.now() })
}

/** 解开用户主动保存的本机副本；缺失、损坏或换了系统账户时安全地回退 null。 */
export function getManagedPrivateKeyMaterial(key: SavedPrivateKey): Buffer | null {
  if (!key.materialRef) return null
  const encoded = vault.getSecret(key.materialRef)
  if (!encoded) return null
  const bytes = Buffer.from(encoded, 'base64')
  return bytes.length > 0 ? bytes : null
}

export function deletePrivateKey(id: PrivateKeyId): DeleteRefResult {
  return tx(() => {
    const usedBy = keyUsedBy(id)
    if (usedBy.length > 0) return { deleted: false, usedBy }
    const key = getPrivateKey(id)
    vault.deleteSecret(key?.passphraseRef)
    vault.deleteSecret(key?.materialRef)
    prepare('DELETE FROM private_keys WHERE id = ?').run(id)
    return { deleted: true }
  })
}

/** 写入即落库，保留此方法只为兼容退出前的 flush 调用 */
export async function flushSavedRefs(): Promise<void> {
  /* no-op */
}
