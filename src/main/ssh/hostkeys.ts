import type { KnownHostEntry, TrustedHostkey } from '@shared/types'
import { prepare } from '../store/Database'

export { fingerprintSha256, parseKeyType } from './keyUtils'

export type HostkeyCheck =
  | { status: 'match' }
  | { status: 'unknown' }
  | { status: 'mismatch'; previous: KnownHostEntry }

/** key = "host:port:keyType"：同主机不同算法算不同记录，避免误报指纹变更 */
function hostKey(host: string, port: number, keyType: string): string {
  return `${host}:${port}:${keyType}`
}

export function checkHostkey(host: string, port: number, keyType: string, fp: string): HostkeyCheck {
  const row = prepare(
    'SELECT key_type, fingerprint, added_at FROM known_hosts WHERE key = ?'
  ).get(hostKey(host, port, keyType)) as
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
  prepare(
    `INSERT INTO known_hosts(key, key_type, fingerprint, added_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint, added_at = excluded.added_at`
  ).run(hostKey(host, port, keyType), keyType, fp, Date.now())
}

/** 「已信任主机」管理面板：全量列出，最近信任的在前 */
export function listKnownHosts(): TrustedHostkey[] {
  const rows = prepare(
    'SELECT key, key_type, fingerprint, added_at FROM known_hosts ORDER BY added_at DESC'
  ).all() as Array<{ key: string; key_type: string; fingerprint: string; added_at: number }>
  return rows.map((r) => {
    // key = "host:port:keyType"。host 可能含 ':'（IPv6 字面量），必须从右往左切两刀
    const typeColon = r.key.lastIndexOf(':')
    const portColon = r.key.lastIndexOf(':', typeColon - 1)
    const port = portColon > 0 ? Number(r.key.slice(portColon + 1, typeColon)) : NaN
    return {
      key: r.key,
      host: portColon > 0 ? r.key.slice(0, portColon) : r.key,
      port: Number.isFinite(port) ? port : 0,
      // 算法以列值为准（key 里的那份只是主键的组成部分）
      keyType: r.key_type,
      fingerprintSha256: r.fingerprint,
      addedAt: r.added_at
    }
  })
}

/** 撤销一条信任：下次连接该主机会重新走首次确认（TOFU）弹窗 */
export function deleteKnownHost(key: string): void {
  prepare('DELETE FROM known_hosts WHERE key = ?').run(key)
}

/** 写入即落库，保留此方法只为兼容退出前的 flush 调用 */
export async function flushKnownHosts(): Promise<void> {
  /* no-op */
}
