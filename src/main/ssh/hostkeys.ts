import type { KnownHostEntry } from '@shared/types'
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

/** 写入即落库，保留此方法只为兼容退出前的 flush 调用 */
export async function flushKnownHosts(): Promise<void> {
  /* no-op */
}
