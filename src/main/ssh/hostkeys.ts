import type { KnownHostEntry, TrustedHostkey } from '@shared/types'
import { prepare } from '../store/Database'
import { encField, tokenize, tryDecField } from '../store/crypto'

export { fingerprintSha256, parseKeyType } from './keyUtils'

export type HostkeyCheck =
  | { status: 'match' }
  | { status: 'unknown' }
  | { status: 'mismatch'; previous: KnownHostEntry }

/** 明文规范键 = "host:port:keyType"：同主机不同算法算不同记录，避免误报指纹变更 */
function hostKey(host: string, port: number, keyType: string): string {
  return `${host}:${port}:${keyType}`
}

/**
 * at-rest 加密开启后，主键 `key` 存的是明文规范键的**决定论 token**（HMAC），
 * 等值查找/去重照常；明文规范键加密后存 `host_enc` 列，供管理面板还原 host/port。
 * 加密关闭时 tokenize/encField 退化为明文，行为与从前一致。
 */
export function checkHostkey(host: string, port: number, keyType: string, fp: string): HostkeyCheck {
  const row = prepare(
    'SELECT key_type, fingerprint, added_at FROM known_hosts WHERE key = ?'
  ).get(tokenize(hostKey(host, port, keyType))) as
    | { key_type: string; fingerprint: string; added_at: number }
    | undefined
  if (!row) return { status: 'unknown' }
  if (row.fingerprint === fp) return { status: 'match' }
  return {
    status: 'mismatch',
    previous: { keyType: row.key_type, fingerprintSha256: row.fingerprint, addedAt: row.added_at }
  }
}

export function trustHostkey(host: string, port: number, keyType: string, fp: string): void {
  const canonical = hostKey(host, port, keyType)
  prepare(
    `INSERT INTO known_hosts(key, key_type, fingerprint, added_at, host_enc) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint, added_at = excluded.added_at`
  ).run(tokenize(canonical), keyType, fp, Date.now(), encField(canonical))
}

/** 「已信任主机」管理面板：全量列出，最近信任的在前 */
export function listKnownHosts(): TrustedHostkey[] {
  const rows = prepare(
    'SELECT key, key_type, fingerprint, added_at, host_enc FROM known_hosts ORDER BY added_at DESC'
  ).all() as Array<{
    key: string
    key_type: string
    fingerprint: string
    added_at: number
    host_enc: string | null
  }>
  return rows
    .map((r) => {
      // 明文规范键来自 host_enc（未迁移的老行 host_enc 为 NULL，回落到 key 本身——那时 key 就是明文）；
      // 解不开（换机 key 丢失）就跳过这一行，不让整张列表读取抛错
      const canonical = r.host_enc != null ? tryDecField(r.host_enc) : r.key
      if (canonical === null) return null
      // canonical = "host:port:keyType"。host 可能含 ':'（IPv6 字面量），必须从右往左切两刀
      const typeColon = canonical.lastIndexOf(':')
      const portColon = canonical.lastIndexOf(':', typeColon - 1)
      const port = portColon > 0 ? Number(canonical.slice(portColon + 1, typeColon)) : NaN
      return {
        // key 现在是不透明 token，作为删除时回传的 id（renderer 一直把它当不透明 id）
        key: r.key,
        host: portColon > 0 ? canonical.slice(0, portColon) : canonical,
        port: Number.isFinite(port) ? port : 0,
        // 算法以列值为准（明文键里的那份只是主键的组成部分）
        keyType: r.key_type,
        fingerprintSha256: r.fingerprint,
        addedAt: r.added_at
      }
    })
    .filter((x): x is TrustedHostkey => x !== null)
}

/** 撤销一条信任：下次连接该主机会重新走首次确认（TOFU）弹窗。key 为 listKnownHosts 回传的 token */
export function deleteKnownHost(key: string): void {
  prepare('DELETE FROM known_hosts WHERE key = ?').run(key)
}

/** 写入即落库，保留此方法只为兼容退出前的 flush 调用 */
export async function flushKnownHosts(): Promise<void> {
  /* no-op */
}
