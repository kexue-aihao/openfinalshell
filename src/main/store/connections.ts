import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  ConnectionGroup,
  ConnectionProfile,
  GroupId,
  ProfileDraft,
  ProfileId,
  SavedPrivateKey,
  SavedProxy
} from '@shared/types'
import { metaGet, metaSet, prepare, tx } from './Database'
import { listPrivateKeys, listProxies, upsertPrivateKey, upsertProxy } from './savedRefs'
import { vault } from './Vault'

/**
 * 连接与分组。profiles 表里领域对象整体存 json 列，
 * id/name/group_id/时间戳是独立列（要排序、要按分组查、要索引）——
 * ConnectionProfile 是深层嵌套结构，全摊平成列会让每加一个字段都得改表。
 */

function rowToProfile(row: { json: string }): ConnectionProfile {
  return JSON.parse(row.json) as ConnectionProfile
}

export function listConnections(): { profiles: ConnectionProfile[]; groups: ConnectionGroup[] } {
  const profiles = (
    prepare('SELECT json FROM profiles ORDER BY created_at').all() as Array<{ json: string }>
  ).map(rowToProfile)
  const groups = (
    prepare('SELECT id, name, parent_id, sort_order FROM conn_groups ORDER BY sort_order, name').all() as Array<{
      id: string
      name: string
      parent_id: string | null
      sort_order: number
    }>
  ).map((g) => ({ id: g.id, name: g.name, parentId: g.parent_id, order: g.sort_order }))
  return { profiles, groups }
}

export function getProfile(id: ProfileId): ConnectionProfile | undefined {
  const row = prepare('SELECT json FROM profiles WHERE id = ?').get(id) as
    | { json: string }
    | undefined
  return row ? rowToProfile(row) : undefined
}

/** 整条写入/覆盖。导出为了给导入用：那边不该再抄一份与表结构耦合的 SQL */
export function upsertProfile(p: ConnectionProfile): void {
  prepare(
    `INSERT INTO profiles(id, name, group_id, json, created_at, updated_at, last_used_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, group_id = excluded.group_id, json = excluded.json,
       updated_at = excluded.updated_at, last_used_at = excluded.last_used_at`
  ).run(
    p.id,
    p.name,
    p.groupId,
    JSON.stringify(p),
    p.createdAt,
    p.updatedAt,
    p.lastUsedAt ?? null
  )
}

/** 保存草稿：明文密码/口令转 Vault 引用后落盘 */
export function saveProfile(draft: ProfileDraft): ConnectionProfile {
  const now = Date.now()
  const existing = draft.id ? getProfile(draft.id) : undefined

  return tx(() => {
    let passwordRef = existing?.auth.passwordRef

    if (draft.auth.clearPassword) {
      vault.deleteSecret(passwordRef)
      passwordRef = undefined
    }
    if (draft.auth.password !== undefined && draft.auth.password !== '') {
      passwordRef = vault.putSecret(draft.auth.password, passwordRef)
    }

    const profile: ConnectionProfile = {
      id: existing?.id ?? randomUUID(),
      name: draft.name,
      protocol: draft.protocol,
      groupId: draft.groupId,
      color: draft.color,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      auth: {
        method: draft.auth.method,
        passwordRef,
        privateKeyId: draft.auth.privateKeyId
      },
      terminal: draft.terminal,
      options: draft.options,
      proxyMode: draft.proxyMode,
      proxyId: draft.proxyId,
      jumpHostId: draft.jumpHostId,
      note: draft.note,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt
    }
    upsertProfile(profile)
    return profile
  })
}

export function deleteProfile(id: ProfileId): void {
  tx(() => {
    const p = getProfile(id)
    /*
     * ⚠️ **只删这条连接独占的密码。**
     *
     * 代理密码与私钥口令归 SavedProxy / SavedPrivateKey，而那两样是**多台机器共享**的：
     * 在这里按 ref 删，就等于"删掉一台机器，其他所有用同一个代理的机器的代理密码一起没了"，
     * 而且不抛任何异常 —— 用户下次连接才发现要重填。v0.3 及以前代理是内联的、
     * ref 确实独占，所以那时删是对的；改成引用之后就成了这次改造最容易引进的 bug。
     * 共享实体的 Vault 条目由 savedRefs.ts 的 deleteProxy / deletePrivateKey 负责，
     * 而它们只在"没人引用"时才会走到删除那一步。
     */
    if (p) vault.deleteSecret(p.auth.passwordRef)
    prepare('DELETE FROM profiles WHERE id = ?').run(id)
    // 该连接下的转发规则一并清掉，避免留下指向不存在 profile 的孤儿规则
    prepare('DELETE FROM forwards WHERE profile_id = ?').run(id)
  })
}

export function duplicateProfile(id: ProfileId): ConnectionProfile {
  const src = getProfile(id)
  if (!src) throw new Error('连接不存在')
  return tx(() => {
    /*
     * 只复制**这条连接独占的**那份密码。理由与 deleteProfile 那段是同一条：
     * 独占的 ref 必须复制（否则删掉原连接会把副本的密码一起带走），
     * 而 proxyId / privateKeyId 是**共享实体的 id**，副本直接沿用同一个 id ——
     * 复制它们的密码会在 Vault 里留下一条永远没人按 id 引用的孤儿条目。
     */
    const copyRef = (ref?: string): string | undefined => {
      if (!ref) return undefined
      const plain = vault.getSecret(ref)
      return plain === null ? undefined : vault.putSecret(plain)
    }
    const copy: ConnectionProfile = {
      ...structuredClone(src),
      id: randomUUID(),
      name: `${src.name} (副本)`,
      auth: {
        ...src.auth,
        passwordRef: copyRef(src.auth.passwordRef)
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: undefined
    }
    upsertProfile(copy)
    return copy
  })
}

export function touchProfile(id: ProfileId): void {
  const p = getProfile(id)
  if (!p) return
  p.lastUsedAt = Date.now()
  upsertProfile(p)
}

/** 保存密码到已有 profile（临时密码勾选"记住"时） */
export function rememberPassword(id: ProfileId, password: string): void {
  tx(() => {
    const p = getProfile(id)
    if (!p) return
    p.auth.passwordRef = vault.putSecret(password, p.auth.passwordRef)
    upsertProfile(p)
  })
}

export function saveGroup(group: ConnectionGroup): void {
  const id = group.id || randomUUID()
  prepare(
    `INSERT INTO conn_groups(id, name, parent_id, sort_order) VALUES(?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id,
                                   sort_order = excluded.sort_order`
  ).run(id, group.name, group.parentId, group.order)
}

export function deleteGroup(id: GroupId): void {
  tx(() => {
    // 组内连接与子组上移到父级，不级联删除
    const g = prepare('SELECT parent_id FROM conn_groups WHERE id = ?').get(id) as
      | { parent_id: string | null }
      | undefined
    const parent = g?.parent_id ?? null
    for (const row of prepare('SELECT json FROM profiles WHERE group_id = ?').all(id) as Array<{
      json: string
    }>) {
      const p = rowToProfile(row)
      p.groupId = parent
      upsertProfile(p)
    }
    prepare('UPDATE conn_groups SET parent_id = ? WHERE parent_id = ?').run(parent, id)
    prepare('DELETE FROM conn_groups WHERE id = ?').run(id)
  })
}

// ---------------------------------------------------------------------------
// 一次性迁移：内联代理 / 私钥路径 → 可复用的实体
// ---------------------------------------------------------------------------

/**
 * 把 v0.3 及以前**内联在每条连接上**的代理与私钥路径，抽成 `proxies` / `private_keys`
 * 两张表里的记录，连接改为按 id 引用。由 meta 标记保证只跑一次。
 *
 * **`passwordRef` / `passphraseRef` 一律原样搬过去** —— 它们已经是 Vault 引用，
 * 不需要也不能重新加密。搬丢了的表现是"升级之后所有代理密码和私钥口令都要重填"，
 * 而且不会有任何报错，所以这是本函数最要紧的一条。
 *
 * 旧字段（`proxy` / `auth.privateKeyPath` / `auth.passphraseRef`）**留在 JSON 列里不删**：
 * 代价是一点冗余，换来的是"迁移映射错了还能人工找回"—— 与 v0.1.0 那次 JSON 迁移
 * 把原文件改名 `.migrated` 而不是删除是同一条取舍。
 */
export function migrateInlineRefsOnce(): void {
  if (metaGet('inline_proxy_key_migrated_v1')) return
  tx(() => {
    const profiles = (
      prepare('SELECT json FROM profiles').all() as Array<{ json: string }>
    ).map(rowToProfile)
    extractInlineRefs(profiles)
    metaSet('inline_proxy_key_migrated_v1', String(Date.now()))
  })
}

/**
 * 抽取的核心：给一批 profile 就地补上 `proxyId` / `auth.privateKeyId`，
 * 需要的实体顺手建出来（已有的按四要素/路径复用），改过的 profile 写回库。
 *
 * **提成独立函数是因为有两个调用方**：升级时的一次性迁移，以及**导入一个 v0.3 导出文件**时。
 * 后者同样会带进来一批内联代理与私钥路径 —— 少了这一步，导入的连接会静默变成
 * "直连、没有私钥"，而用户要到第一次连接失败才发现。两处各写一遍是这个项目最不该犯的错。
 *
 * 返回新建了多少条，供导入结果里报数。
 */
export function extractInlineRefs(profiles: ConnectionProfile[]): {
  proxies: number
  keys: number
} {
  /*
   * ⚠️ **本函数不自己开事务，调用方必须已经在一个 tx() 里。**
   * `tx()` 用的是 `BEGIN IMMEDIATE`，SQLite 不支持嵌套 —— 自己开的话，
   * 从 applyImport（它整段都在一个事务里）调过来会当场炸 "cannot start a
   * transaction within a transaction"。两个调用方都已经在事务里了。
   */
  {
    const now = Date.now()
    let newProxies = 0
    let newKeys = 0
    // 已有的实体也要参与去重，否则导入会把同一个代理再建一条
    const existingProxies = listProxies()
    const existingKeys = listPrivateKeys()

    /** 代理去重键：同一台代理的四要素一致就是同一条 */
    const proxyByKey = new Map<string, SavedProxy>(
      existingProxies.map((x) => [`${x.type}|${x.host}|${x.port}|${x.username ?? ''}`, x])
    )
    /** 私钥按路径去重；同路径但口令不同的情况见下面那段 */
    const keysByPath = new Map<string, SavedPrivateKey[]>()
    for (const k of existingKeys) {
      keysByPath.set(k.path, [...(keysByPath.get(k.path) ?? []), k])
    }
    const usedNames = new Set<string>([
      ...existingProxies.map((x) => x.name),
      ...existingKeys.map((x) => x.name)
    ])

    /** 重名就加序号 —— 迁移出来的名字只是默认值，用户随时能改 */
    const uniqueName = (base: string): string => {
      let name = base
      let n = 2
      while (usedNames.has(name)) name = `${base} (${n++})`
      usedNames.add(name)
      return name
    }

    for (const p of profiles) {
      let changed = false

      // ---- 代理 ----
      // type='none' 的连接在库里本来就是 proxy: undefined（saveProfile 那边会清掉），
      // 这里再判一次是为了容忍手工改过库的情况
      const old = p.proxy
      if (old && old.type !== 'none' && old.host.trim() !== '' && !p.proxyId) {
        const key = `${old.type}|${old.host.trim()}|${old.port}|${old.username ?? ''}`
        let saved = proxyByKey.get(key)
        if (!saved) {
          saved = {
            id: randomUUID(),
            name: uniqueName(`${old.host.trim()}:${old.port}`),
            type: old.type,
            host: old.host.trim(),
            port: old.port,
            username: old.username,
            passwordRef: old.passwordRef,
            createdAt: now,
            updatedAt: now
          }
          proxyByKey.set(key, saved)
          upsertProxy(saved)
          newProxies++
        }
        p.proxyId = saved.id
        changed = true
      }

      // ---- 私钥 ----
      /*
       * 判据是"路径非空"，**不看 auth.method**：saveProfile 无条件保留 privateKeyPath，
       * 所以一条切回密码认证的连接里那份路径仍然是用户填过的真东西，丢了就得重填。
       */
      const path = p.auth.privateKeyPath?.trim()
      if (path && !p.auth.privateKeyId) {
        const bucket = keysByPath.get(path) ?? []
        /*
         * 同一路径但口令不同 → **另建一条**。
         * 只按路径去重会让后一条的 passphraseRef 被丢掉（用户得重填那个口令），
         * 宁可库里多一条名字带序号的记录。
         */
        let saved = bucket.find(
          (k) => (k.passphraseRef ?? '') === (p.auth.passphraseRef ?? '')
        )
        if (!saved) {
          saved = {
            id: randomUUID(),
            name: uniqueName(basename(path) || path),
            path,
            passphraseRef: p.auth.passphraseRef,
            createdAt: now,
            updatedAt: now
          }
          bucket.push(saved)
          keysByPath.set(path, bucket)
          upsertPrivateKey(saved)
          newKeys++
        }
        p.auth.privateKeyId = saved.id
        changed = true
      }

      if (changed) upsertProfile(p)
    }

    return { proxies: newProxies, keys: newKeys }
  }
}

/** 写入即落库，保留此方法只为兼容退出前的 flush 调用 */
export async function flushConnections(): Promise<void> {
  /* no-op */
}
