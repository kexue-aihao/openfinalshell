import { randomUUID } from 'node:crypto'
import { prepare, tx } from '../store/Database'
import { vault } from '../store/Vault'
import type { AiProviderProfile, AiProviderProfileDraft } from '@shared/types'

const DEFAULT_PROFILES = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
] as const

export function normalizeAiBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('AI API 地址无效') }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('AI API 地址必须使用 HTTPS（本机地址可使用 HTTP）')
  }
  if (url.username || url.password) throw new Error('AI API 地址不得包含账号或密码')
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1'
  if (url.pathname === '/') url.pathname = '/v1'
  return url.toString().replace(/\/$/, '')
}

function rowToProfile(row: Record<string, unknown>): AiProviderProfile {
  return {
    id: String(row.id), name: String(row.name), baseUrl: String(row.base_url),
    model: String(row.model), enabled: Number(row.enabled) !== 0,
    hasToken: typeof row.secret_ref === 'string' && row.secret_ref.length > 0,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  }
}

function ensureDefaults(): void {
  const count = Number((prepare('SELECT COUNT(*) AS count FROM ai_profiles').get() as { count: number }).count)
  if (count > 0) return
  const now = Date.now()
  for (const profile of DEFAULT_PROFILES) {
    prepare('INSERT INTO ai_profiles(id,name,base_url,model,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), profile.name, profile.baseUrl, profile.model, 1, now, now)
  }
}

export function listAiProfiles(): AiProviderProfile[] {
  ensureDefaults()
  return (prepare('SELECT id,name,base_url,model,enabled,secret_ref,created_at,updated_at FROM ai_profiles ORDER BY created_at').all() as Record<string, unknown>[]).map(rowToProfile)
}

export function getAiProfile(id: string): (AiProviderProfile & { secretRef?: string }) | undefined {
  const row = prepare('SELECT id,name,base_url,model,enabled,secret_ref,created_at,updated_at FROM ai_profiles WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return undefined
  const profile = rowToProfile(row)
  return { ...profile, secretRef: typeof row.secret_ref === 'string' ? row.secret_ref : undefined }
}

export function saveAiProfile(draft: AiProviderProfileDraft): AiProviderProfile {
  const name = draft.name.trim().slice(0, 100)
  const model = draft.model.trim().slice(0, 200)
  if (!name || !model) throw new Error('AI 服务名称和模型不能为空')
  const baseUrl = normalizeAiBaseUrl(draft.baseUrl)
  return tx(() => {
    const old = draft.id ? getAiProfile(draft.id) : undefined
    if (draft.id && !old) throw new Error('AI 服务配置不存在')
    let secretRef = old?.secretRef
    if (draft.clearToken) {
      vault.deleteSecret(secretRef)
      secretRef = undefined
    }
    if (draft.token !== undefined && draft.token.trim() !== '') {
      secretRef = vault.putSecretIfAvailable(draft.token.trim(), secretRef)
      if (!secretRef) throw new Error('系统安全存储不可用，无法保存 AI Token')
    }
    const now = Date.now()
    const id = old?.id ?? randomUUID()
    const createdAt = old?.createdAt ?? now
    prepare(`INSERT INTO ai_profiles(id,name,base_url,model,enabled,secret_ref,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,
      model=excluded.model,enabled=excluded.enabled,secret_ref=excluded.secret_ref,updated_at=excluded.updated_at`)
      .run(id, name, baseUrl, model, draft.enabled === false ? 0 : 1, secretRef ?? null, createdAt, now)
    return listAiProfiles().find((p) => p.id === id)!
  })
}

export function deleteAiProfile(id: string): void {
  tx(() => {
    const profile = getAiProfile(id)
    if (!profile) return
    vault.deleteSecret(profile.secretRef)
    prepare('DELETE FROM ai_profiles WHERE id = ?').run(id)
  })
}

export function getAiToken(id: string): { profile: AiProviderProfile; token: string } {
  const profile = getAiProfile(id)
  if (!profile) throw new Error('AI 服务配置不存在')
  if (!profile.secretRef) throw new Error('AI Token 未配置')
  const token = vault.getSecret(profile.secretRef)
  if (!token) throw new Error('AI Token 无法解密，请重新配置')
  return { profile, token }
}
