import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, configFile } from './paths'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('db')

/**
 * 单文件 SQLite 数据库（node:sqlite —— Electron/Node 内置，不引任何 native 依赖，
 * 因此 32 位构建也不需要额外工具链，符合项目的零 native 硬依赖红线）。
 *
 * 为什么从 JSON 文件换成 SQLite：
 * - 每次改一条连接不再重写整个文件，也不再依赖 tmp+rename 那套手写原子写
 *   （进程在 rename 前退出就会留下 .tmp 且改动丢失，实际踩到过）
 * - 多个实例同时运行时不会互相覆盖：以前是各自持有整份内存副本、后写的赢
 * - 导出/备份可以用 VACUUM INTO 拿到一致快照
 *
 * 存储取向是刻意的混合：集合类数据（连接/分组/片段/转发/known_hosts/凭据）用真表，
 * 领域对象本身存 JSON 列 —— ConnectionProfile 是深层嵌套结构（auth/terminal/options/proxy），
 * 全量摊平成列会让每加一个字段都要改表；而 id/name/group_id/时间戳这些要查询要排序的，
 * 是独立列并建索引。settings 是单份深层嵌套配置，整体存一行 JSON。
 */

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 深层嵌套的单份配置（settings 等）
CREATE TABLE IF NOT EXISTS documents (
  name TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conn_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT,
  sort_order REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  group_id     TEXT,
  json         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles(group_id);

-- 凭据密文（safeStorage/DPAPI 加密后的字节），明文永不落库
CREATE TABLE IF NOT EXISTS secrets (
  ref    TEXT PRIMARY KEY,
  cipher BLOB NOT NULL
);

-- key = "host:port:keyType"，同主机不同算法算不同记录，避免误报指纹变更
CREATE TABLE IF NOT EXISTS known_hosts (
  key         TEXT PRIMARY KEY,
  key_type    TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  added_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snippet_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snippets (
  id         TEXT PRIMARY KEY,
  group_id   TEXT,
  json       TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS forwards (
  id         TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forwards_profile ON forwards(profile_id);
`

let db: DatabaseSync | null = null

export function databaseFile(): string {
  return join(configDir(), 'openfinalshell.db')
}

export function database(): DatabaseSync {
  if (db) return db
  mkdirSync(configDir(), { recursive: true })
  const conn = new DatabaseSync(databaseFile())
  // WAL：写入不重写整库、崩溃安全；busy_timeout 让多实例并发写等一会儿而不是直接报错
  conn.exec('PRAGMA journal_mode = WAL')
  conn.exec('PRAGMA synchronous = NORMAL')
  conn.exec('PRAGMA busy_timeout = 5000')
  conn.exec(SCHEMA)
  const current = Number(readMeta(conn, 'schema_version') ?? '0')
  if (current === 0) writeMeta(conn, 'schema_version', String(SCHEMA_VERSION))
  db = conn
  importLegacyJson(conn)
  return conn
}

/** 测试与退出时释放句柄（WAL 会在最后一个连接关闭时归并） */
export function closeDatabase(): void {
  if (!db) return
  try {
    db.close()
  } catch (err) {
    log.warn(`close database failed: ${String(err)}`)
  }
  db = null
}

function readMeta(conn: DatabaseSync, key: string): string | null {
  const row = conn.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function writeMeta(conn: DatabaseSync, key: string, value: string): void {
  conn.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(
    key,
    value,
    value
  )
}

export function metaGet(key: string): string | null {
  return readMeta(database(), key)
}

export function metaSet(key: string, value: string): void {
  writeMeta(database(), key, value)
}

/** 事务包装：抛异常即整体回滚 */
export function tx<T>(fn: (conn: DatabaseSync) => T): T {
  const conn = database()
  conn.exec('BEGIN IMMEDIATE')
  try {
    const out = fn(conn)
    conn.exec('COMMIT')
    return out
  } catch (err) {
    try {
      conn.exec('ROLLBACK')
    } catch {
      /* 回滚失败无可挽回，交给上层报错 */
    }
    throw err
  }
}

export function prepare(sql: string): StatementSync {
  return database().prepare(sql)
}

// ---------------- 旧 JSON 配置的一次性导入 ----------------

/**
 * 从 v0.1.0 的 JSON 配置迁移。导入后把原文件改名为 *.migrated 而不是删除 ——
 * 万一映射有偏差还能人工找回。只在 meta 里没有导入标记时执行一次。
 */
function importLegacyJson(conn: DatabaseSync): void {
  if (readMeta(conn, 'legacy_json_imported')) return

  const read = <T>(path: string): T | null => {
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T
    } catch (err) {
      log.error(`legacy config unreadable, skipped: ${path}`, err)
      return null
    }
  }

  const imported: string[] = []
  try {
    conn.exec('BEGIN IMMEDIATE')

    const settings = read<Record<string, unknown>>(configFile.settings())
    if (settings) {
      conn
        .prepare('INSERT INTO documents(name, json) VALUES(?, ?) ON CONFLICT(name) DO NOTHING')
        .run('settings', JSON.stringify(settings))
      imported.push('settings')
    }

    const conns = read<{
      profiles?: Array<Record<string, unknown>>
      groups?: Array<Record<string, unknown>>
    }>(configFile.connections())
    if (conns) {
      const insGroup = conn.prepare(
        'INSERT INTO conn_groups(id, name, parent_id, sort_order) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
      )
      for (const g of conns.groups ?? []) {
        insGroup.run(
          String(g.id),
          String(g.name ?? ''),
          (g.parentId as string | null) ?? null,
          Number(g.order ?? 0)
        )
      }
      const insProfile = conn.prepare(
        `INSERT INTO profiles(id, name, group_id, json, created_at, updated_at, last_used_at)
         VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
      )
      for (const p of conns.profiles ?? []) {
        insProfile.run(
          String(p.id),
          String(p.name ?? ''),
          (p.groupId as string | null) ?? null,
          JSON.stringify(p),
          Number(p.createdAt ?? Date.now()),
          Number(p.updatedAt ?? Date.now()),
          p.lastUsedAt === undefined ? null : Number(p.lastUsedAt)
        )
      }
      imported.push(`connections(${(conns.profiles ?? []).length})`)
    }

    const snips = read<{
      groups?: Array<Record<string, unknown>>
      snippets?: Array<Record<string, unknown>>
    }>(configFile.snippets())
    if (snips) {
      const insGroup = conn.prepare(
        'INSERT INTO snippet_groups(id, name, sort_order) VALUES(?, ?, ?) ON CONFLICT(id) DO NOTHING'
      )
      for (const g of snips.groups ?? []) {
        insGroup.run(String(g.id), String(g.name ?? ''), Number(g.order ?? 0))
      }
      const insSnippet = conn.prepare(
        'INSERT INTO snippets(id, group_id, json, sort_order) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
      )
      for (const s of snips.snippets ?? []) {
        insSnippet.run(
          String(s.id),
          (s.groupId as string | null) ?? null,
          JSON.stringify(s),
          Number(s.order ?? 0)
        )
      }
      imported.push(`snippets(${(snips.snippets ?? []).length})`)
    }

    const kh = read<{ entries?: Record<string, Record<string, unknown>> }>(configFile.knownHosts())
    if (kh) {
      const ins = conn.prepare(
        `INSERT INTO known_hosts(key, key_type, fingerprint, added_at)
         VALUES(?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`
      )
      for (const [key, e] of Object.entries(kh.entries ?? {})) {
        ins.run(
          key,
          String(e.keyType ?? ''),
          String(e.fingerprintSha256 ?? ''),
          Number(e.addedAt ?? Date.now())
        )
      }
      imported.push(`known_hosts(${Object.keys(kh.entries ?? {}).length})`)
    }

    const fwd = read<{ rules?: Array<Record<string, unknown>> }>(configFile.forwards())
    if (fwd) {
      const ins = conn.prepare(
        'INSERT INTO forwards(id, profile_id, json) VALUES(?, ?, ?) ON CONFLICT(id) DO NOTHING'
      )
      for (const r of fwd.rules ?? []) {
        ins.run(String(r.id), String(r.profileId ?? ''), JSON.stringify(r))
      }
      imported.push(`forwards(${(fwd.rules ?? []).length})`)
    }

    const vault = read<{ entries?: Record<string, string> }>(configFile.vault())
    if (vault) {
      const ins = conn.prepare(
        'INSERT INTO secrets(ref, cipher) VALUES(?, ?) ON CONFLICT(ref) DO NOTHING'
      )
      for (const [ref, b64] of Object.entries(vault.entries ?? {})) {
        ins.run(ref, Buffer.from(b64, 'base64'))
      }
      imported.push(`secrets(${Object.keys(vault.entries ?? {}).length})`)
    }

    writeMeta(conn, 'legacy_json_imported', String(Date.now()))
    conn.exec('COMMIT')
  } catch (err) {
    try {
      conn.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    log.error('legacy JSON import failed, keeping files untouched', err)
    return
  }

  // 导入成功后再改名，失败也不影响已入库的数据
  for (const path of [
    configFile.settings(),
    configFile.connections(),
    configFile.snippets(),
    configFile.knownHosts(),
    configFile.vault(),
    configFile.forwards()
  ]) {
    if (!existsSync(path)) continue
    try {
      renameSync(path, `${path}.migrated`)
    } catch (err) {
      log.warn(`failed to rename migrated config ${path}: ${String(err)}`)
    }
  }
  if (imported.length > 0) log.info(`migrated legacy JSON config: ${imported.join(', ')}`)
}
