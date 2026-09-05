import { metaGet, metaSet, tx } from './Database'
import {
  DATA_ENCRYPTION_DIRTY_META_KEY,
  decField,
  encField,
  isDataEncryptionAvailable,
  isEncrypted,
  tokenize
} from './crypto'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('encrypt-migrate')
const FLAG = 'rows_encrypted_v1'

/** 已是密文就原样返回，否则加密——保证迁移幂等（部分迁移/重跑都安全） */
function encIf(value: string): string {
  return isEncrypted(value) ? value : encField(value)
}

/**
 * 一次性把库里现有明文行就地加密（at-rest）。仿照 `migrateInlineRefsOnce` 的形态：
 * meta 标记守卫 + 整段在一个 `tx()` 里 + 标记写在同一事务内（崩溃则整体回滚、下次干净重跑）。
 *
 * safeStorage 不可用（无 MDK）时**直接返回且不写标记**——等哪次启动 safeStorage 可用了再跑，
 * 期间读写都走 crypto 的明文降级，不 brick。
 *
 * 两类列分开处理：
 * - Tier A（不透明载荷 / 标签列）：就地 `encField` 更新 json / name 列。
 * - Tier B（等值查找列 known_hosts / command_history）：主键要从明文换成决定论 token，
 *   SQLite 改主键最稳的做法是**整表读出 → 清空 → 以 token/enc 重插**。
 */
export function encryptExistingRowsOnce(): void {
  // 已完成迁移后若曾因安全后端不可用而降级写入明文，dirty 标记会要求重扫一次。
  if (metaGet(FLAG) && metaGet(DATA_ENCRYPTION_DIRTY_META_KEY) !== '1') return
  if (!isDataEncryptionAvailable()) return

  tx((conn) => {
    // ---- Tier A：json / name 列就地加密 ----
    const encodeCol = (table: string, idCol: string, cols: string[]): void => {
      const rows = conn.prepare(`SELECT ${idCol}, ${cols.join(', ')} FROM ${table}`).all() as Array<
        Record<string, string>
      >
      const set = cols.map((c) => `${c} = ?`).join(', ')
      const upd = conn.prepare(`UPDATE ${table} SET ${set} WHERE ${idCol} = ?`)
      for (const r of rows) {
        upd.run(...cols.map((c) => encIf(r[c])), r[idCol])
      }
    }
    encodeCol('profiles', 'id', ['name', 'json'])
    encodeCol('conn_groups', 'id', ['name'])
    encodeCol('snippets', 'id', ['json'])
    encodeCol('snippet_groups', 'id', ['name'])
    encodeCol('forwards', 'id', ['json'])
    encodeCol('proxies', 'id', ['name', 'json'])
    encodeCol('private_keys', 'id', ['name', 'json'])
    // 注：settings（documents 表）刻意不加密——它不含主机/凭据类机密，且要在 app ready 前
    // 读取（决定是否禁用 GPU），此时 safeStorage 尚不可用，加密会引入启动期解密失败的隐患。

    // ---- Tier B：known_hosts 重键（key → token，明文进 host_enc）----
    {
      const rows = conn
        .prepare('SELECT key, key_type, fingerprint, added_at, host_enc FROM known_hosts')
        .all() as Array<{
        key: string
        key_type: string
        fingerprint: string
        added_at: number
        host_enc: string | null
      }>
      conn.prepare('DELETE FROM known_hosts').run()
      const ins = conn.prepare(
        'INSERT INTO known_hosts(key, key_type, fingerprint, added_at, host_enc) VALUES(?, ?, ?, ?, ?)'
      )
      for (const r of rows) {
        // 未迁移行 host_enc 为 NULL、key 是明文；已迁移行 key 已是 token、明文在 host_enc
        const plain = r.host_enc ? decOrRaw(r.host_enc) : r.key
        ins.run(tokenize(plain), r.key_type, r.fingerprint, r.added_at, encField(plain))
      }
    }

    // ---- Tier B：command_history 重键（command → token，原文进 cmd_enc）----
    {
      const rows = conn
        .prepare('SELECT command, last_used_at, use_count, cmd_enc FROM command_history')
        .all() as Array<{
        command: string
        last_used_at: number
        use_count: number
        cmd_enc: string | null
      }>
      conn.prepare('DELETE FROM command_history').run()
      const ins = conn.prepare(
        'INSERT INTO command_history(command, last_used_at, use_count, cmd_enc) VALUES(?, ?, ?, ?)'
      )
      for (const r of rows) {
        const plain = r.cmd_enc ? decOrRaw(r.cmd_enc) : r.command
        ins.run(tokenize(plain), r.last_used_at, r.use_count, encField(plain))
      }
    }

    metaSet(FLAG, String(Date.now()))
    metaSet(DATA_ENCRYPTION_DIRTY_META_KEY, '0')
  })
  log.info('existing rows encrypted at rest')
}

/** 防御性：已迁移行的 host_enc/cmd_enc 是密文，解出明文；解不开就原样（不应发生，仅兜底） */
function decOrRaw(value: string): string {
  try {
    return decField(value)
  } catch {
    return value
  }
}
