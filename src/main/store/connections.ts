import { randomUUID } from 'node:crypto'
import type { ConnectionGroup, ConnectionProfile, GroupId, ProfileDraft, ProfileId } from '@shared/types'
import { JsonFileStore } from './ConfigStore'
import { configFile } from './paths'
import { vault } from './Vault'

interface ConnectionsFile {
  version: number
  profiles: ConnectionProfile[]
  groups: ConnectionGroup[]
}

let store: JsonFileStore<ConnectionsFile> | null = null

function connStore(): JsonFileStore<ConnectionsFile> {
  if (!store) {
    store = new JsonFileStore<ConnectionsFile>(configFile.connections(), () => ({
      version: 1,
      profiles: [],
      groups: []
    }))
  }
  return store
}

export function listConnections(): { profiles: ConnectionProfile[]; groups: ConnectionGroup[] } {
  const d = connStore().data
  return { profiles: d.profiles, groups: d.groups }
}

export function getProfile(id: ProfileId): ConnectionProfile | undefined {
  return connStore().data.profiles.find((p) => p.id === id)
}

/** 保存草稿：明文密码/口令转 Vault 引用后落盘 */
export function saveProfile(draft: ProfileDraft): ConnectionProfile {
  const now = Date.now()
  const existing = draft.id ? getProfile(draft.id) : undefined

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
    jumpHostId: draft.jumpHostId,
    note: draft.note,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt
  }

  connStore().update((d) => {
    const idx = d.profiles.findIndex((p) => p.id === profile.id)
    if (idx >= 0) d.profiles[idx] = profile
    else d.profiles.push(profile)
  })
  return profile
}

export function deleteProfile(id: ProfileId): void {
  const p = getProfile(id)
  if (p) {
    vault.deleteSecret(p.auth.passwordRef)
    vault.deleteSecret(p.auth.passphraseRef)
  }
  connStore().update((d) => {
    d.profiles = d.profiles.filter((x) => x.id !== id)
  })
}

export function duplicateProfile(id: ProfileId): ConnectionProfile {
  const src = getProfile(id)
  if (!src) throw new Error('连接不存在')
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUsedAt: undefined
  }
  connStore().update((d) => {
    d.profiles.push(copy)
  })
  return copy
}

export function touchProfile(id: ProfileId): void {
  connStore().update((d) => {
    const p = d.profiles.find((x) => x.id === id)
    if (p) p.lastUsedAt = Date.now()
  })
}

/** 保存密码到已有 profile（临时密码勾选"记住"时） */
export function rememberPassword(id: ProfileId, password: string): void {
  connStore().update((d) => {
    const p = d.profiles.find((x) => x.id === id)
    if (p) p.auth.passwordRef = vault.putSecret(password, p.auth.passwordRef)
  })
}

export function saveGroup(group: ConnectionGroup): void {
  connStore().update((d) => {
    const idx = d.groups.findIndex((g) => g.id === group.id)
    if (idx >= 0) d.groups[idx] = group
    else d.groups.push({ ...group, id: group.id || randomUUID() })
  })
}

export function deleteGroup(id: GroupId): void {
  connStore().update((d) => {
    // 组内连接与子组上移到父级，不级联删除
    const g = d.groups.find((x) => x.id === id)
    const parent = g?.parentId ?? null
    for (const p of d.profiles) if (p.groupId === id) p.groupId = parent
    for (const child of d.groups) if (child.parentId === id) child.parentId = parent
    d.groups = d.groups.filter((x) => x.id !== id)
  })
}

export async function flushConnections(): Promise<void> {
  await connStore().flush()
}
