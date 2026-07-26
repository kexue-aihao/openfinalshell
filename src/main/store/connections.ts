import { randomUUID } from 'node:crypto'
import type {
  ConnectionGroup,
  ConnectionProfile,
  ConnectionProxy,
  GroupId,
  ProfileDraft,
  ProfileId
} from '@shared/types'
import { prepare, tx } from './Database'
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

function upsertProfile(p: ConnectionProfile): void {
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
    let passphraseRef = existing?.auth.passphraseRef

    if (draft.auth.clearPassword) {
      vault.deleteSecret(passwordRef)
      passwordRef = undefined
    }
    if (draft.auth.password !== undefined && draft.auth.password !== '') {
      passwordRef = vault.putSecret(draft.auth.password, passwordRef)
    }
    if (draft.auth.passphrase !== undefined && draft.auth.passphrase !== '') {
      passphraseRef = vault.putSecret(draft.auth.passphrase, passphraseRef)
    }

    // 代理：改直连就把代理密码一起从 Vault 里清掉，不留孤儿条目
    let proxy: ConnectionProxy | undefined
    const proxyRef = existing?.proxy?.passwordRef
    if (!draft.proxy || draft.proxy.type === 'none') {
      vault.deleteSecret(proxyRef)
    } else {
      const d = draft.proxy
      proxy = {
        type: d.type,
        host: d.host.trim(),
        port: d.port,
        username: d.username || undefined,
        passwordRef:
          d.password !== undefined && d.password !== ''
            ? vault.putSecret(d.password, proxyRef)
            : proxyRef
      }
    }

    const profile: ConnectionProfile = {
      id: existing?.id ?? randomUUID(),
      name: draft.name,
      groupId: draft.groupId,
      color: draft.color,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      auth: {
        method: draft.auth.method,
        passwordRef,
        privateKeyPath: draft.auth.privateKeyPath,
        passphraseRef
      },
      terminal: draft.terminal,
      options: draft.options,
      proxy,
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
    if (p) {
      vault.deleteSecret(p.auth.passwordRef)
      vault.deleteSecret(p.auth.passphraseRef)
      vault.deleteSecret(p.proxy?.passwordRef)
    }
    prepare('DELETE FROM profiles WHERE id = ?').run(id)
    // 该连接下的转发规则一并清掉，避免留下指向不存在 profile 的孤儿规则
    prepare('DELETE FROM forwards WHERE profile_id = ?').run(id)
  })
}

export function duplicateProfile(id: ProfileId): ConnectionProfile {
  const src = getProfile(id)
  if (!src) throw new Error('连接不存在')
  return tx(() => {
    // vault 条目复制一份，避免删除原连接时级联删除影响副本
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
        passwordRef: copyRef(src.auth.passwordRef),
        passphraseRef: copyRef(src.auth.passphraseRef)
      },
      proxy: src.proxy ? { ...src.proxy, passwordRef: copyRef(src.proxy.passwordRef) } : undefined,
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

/** 写入即落库，保留此方法只为兼容退出前的 flush 调用 */
export async function flushConnections(): Promise<void> {
  /* no-op */
}
