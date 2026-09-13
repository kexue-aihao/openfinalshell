import { net } from 'electron'
import { emit } from '../ipc/registry'
import { getAiToken, normalizeAiBaseUrl } from './aiProfiles'
import { getSettings } from './settings'
import type { AiChatMessage, AiModelInfo, AiImageCapability, AiProviderProfile } from '@shared/types'

const MAX_MESSAGES = 64
const MAX_CONTENT_CHARS = 32_768
const MAX_RESPONSE_CHARS = 1_000_000
const REQUEST_TIMEOUT_MS = 120_000
const MAX_ACTIVE_REQUESTS = 4
const MAX_MODEL_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_MODELS = 2_000
const active = new Map<string, AbortController>()

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

function errorForStatus(status: number): string {
  if (status === 401) return 'AI Token 无效或已过期'
  if (status === 403) return 'AI 服务拒绝了请求'
  if (status === 404) return 'AI 模型或接口地址不存在'
  if (status === 429) return 'AI 服务请求过于频繁，请稍后重试'
  if (status >= 500) return 'AI 服务暂时不可用'
  return `AI 服务请求失败（HTTP ${status}）`
}

function validateMessages(messages: AiChatMessage[]): void {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) throw new Error('AI 消息数量超出限制')
  for (const message of messages) {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || !validContent(message.content)) {
      throw new Error('AI 消息格式或长度无效')
    }
  }
}

function validContent(content: AiChatMessage['content']): boolean {
  if (typeof content === 'string') return content.length <= MAX_CONTENT_CHARS
  if (!Array.isArray(content) || content.length > 32) return false
  let textChars = 0
  for (const part of content) {
    if (!part || (part.type !== 'text' && part.type !== 'image_url')) return false
    if (part.type === 'text') {
      if (typeof part.text !== 'string') return false
      textChars += part.text.length
      if (textChars > MAX_CONTENT_CHARS) return false
    } else {
      const url = part.image_url?.url
      if (typeof url !== 'string' || url.length > 12 * 1024 * 1024 || !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url)) return false
    }
  }
  return true
}

async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ''
  while (true) {
    const part = await reader.read()
    if (part.done) break
    total += part.value.byteLength
    if (total > limit) throw new Error('AI 模型列表响应过大')
    output += decoder.decode(part.value, { stream: true })
  }
  output += decoder.decode()
  return output
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function imageCapability(value: Record<string, unknown>): AiImageCapability {
  const candidates: unknown[] = [value.input_modalities, value.input, value.modalities]
  const caps = value.capabilities
  if (caps && typeof caps === 'object') {
    const record = caps as Record<string, unknown>
    candidates.push(record.input, record.input_modalities, record.modalities)
    if (record.vision === true || record.image === true) return 'yes'
    if (record.vision === false || record.image === false) return 'no'
  }
  if (value.vision === true || value.supports_vision === true || value.image === true) return 'yes'
  if (value.vision === false || value.supports_vision === false || value.image === false) return 'no'
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const values = candidate.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
    if (values.some((item) => item === 'image' || item === 'images' || item === 'vision')) return 'yes'
    if (values.length > 0 && values.every((item) => item === 'text')) return 'no'
  }
  return 'unknown'
}

function parseModel(value: unknown, fallbackId?: string): AiModelInfo | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : fallbackId
  if (!id) return undefined
  return {
    id,
    name: (typeof row.name === 'string' && row.name.trim() ? row.name : typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name : id).trim(),
    ...(typeof row.owned_by === 'string' && row.owned_by ? { ownedBy: row.owned_by } : {}),
    ...(numberField(row.context_window ?? row.contextWindow ?? row.max_input_tokens) ? { contextWindow: numberField(row.context_window ?? row.contextWindow ?? row.max_input_tokens) } : {}),
    ...(numberField(row.max_output_tokens ?? row.maxOutputTokens ?? row.max_tokens) ? { maxOutputTokens: numberField(row.max_output_tokens ?? row.maxOutputTokens ?? row.max_tokens) } : {}),
    input: { text: true, image: imageCapability(row) }
  }
}

/** Parses standard OpenAI data arrays and DeepSeek Harness enriched model maps. */
export function parseAiModels(payload: unknown): AiModelInfo[] {
  if (!payload || typeof payload !== 'object') return []
  const root = payload as Record<string, unknown>
  const out: AiModelInfo[] = []
  if (Array.isArray(root.data)) {
    for (const entry of root.data) {
      const model = parseModel(entry)
      if (model) out.push(model)
    }
  } else if (root.models && typeof root.models === 'object' && !Array.isArray(root.models)) {
    for (const [id, entry] of Object.entries(root.models as Record<string, unknown>)) {
      const model = parseModel(entry, id)
      if (model) out.push(model)
    }
  }
  const seen = new Set<string>()
  return out.filter((model) => !seen.has(model.id) && seen.add(model.id)).slice(0, MAX_MODELS)
}

export async function discoverAiModels(input: { profileId?: string; baseUrl?: string; token?: string }): Promise<AiModelInfo[]> {
  if (!getSettings().aiAssistantEnabled) throw new Error('AI 助手尚未启用，请先在设置中开启')
  let profile: AiProviderProfile | undefined
  let token = input.token?.trim() ?? ''
  if (input.profileId) {
    const resolved = getAiToken(input.profileId)
    profile = resolved.profile
    if (!token) token = resolved.token
  }
  if (input.baseUrl) {
    const baseUrl = normalizeAiBaseUrl(input.baseUrl)
    profile = profile ? { ...profile, baseUrl } : { id: 'draft', name: 'draft', baseUrl, model: '', enabled: true, hasToken: Boolean(token), createdAt: 0, updatedAt: 0 }
  }
  if (!profile || !token) throw new Error('请提供 API 地址和 Token')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await net.fetch(`${profile.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(errorForStatus(response.status))
    let parsed: unknown
    try { parsed = JSON.parse(await readLimited(response, MAX_MODEL_RESPONSE_BYTES)) as unknown } catch { throw new Error('AI 模型列表响应不是有效 JSON') }
    const models = parseAiModels(parsed)
    if (models.length === 0) throw new Error('AI 服务未返回可用模型')
    return models
  } finally {
    clearTimeout(timer)
  }
}

async function request(profileId: string, messages: AiChatMessage[], stream: boolean, signal: AbortSignal): Promise<Response> {
  const { profile, token } = getAiToken(profileId)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await net.fetch(endpoint(profile.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
      body: JSON.stringify({ model: profile.model, messages, stream, temperature: 0.7, max_tokens: 4096 }),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

async function assertResponse(response: Response): Promise<void> {
  if (response.ok) return
  throw new Error(errorForStatus(response.status))
}

export async function testAiConnection(profileId: string): Promise<{ ok: true; model: string }> {
  if (!getSettings().aiAssistantEnabled) throw new Error('AI 助手尚未启用，请先在设置中开启')
  const { profile } = getAiToken(profileId)
  const controller = new AbortController()
  const response = await request(profileId, [{ role: 'user', content: 'ping' }], false, controller.signal)
  await assertResponse(response)
  return { ok: true, model: profile.model }
}

function emitError(requestId: string, code: string, message: string): void {
  emit('ai:error', { requestId, code, message })
}

export async function chatAi(requestId: string, profileId: string, messages: AiChatMessage[]): Promise<void> {
  if (!getSettings().aiAssistantEnabled) throw new Error('AI 助手尚未启用，请先在设置中开启')
  if (active.has(requestId)) throw new Error('AI 请求已存在')
  if (active.size >= MAX_ACTIVE_REQUESTS) throw new Error('AI 请求过多，请等待当前请求完成')
  validateMessages(messages)
  const controller = new AbortController()
  active.set(requestId, controller)
  const started = Date.now()
  try {
    const response = await request(profileId, messages, true, controller.signal)
    await assertResponse(response)
    if (!response.body) throw new Error('AI 服务未返回响应流')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let total = 0
    const consume = (line: string): void => {
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') return
      try {
        const value = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }
        const text = value.choices?.[0]?.delta?.content
        if (typeof text !== 'string' || text.length === 0) return
        total += text.length
        if (total > MAX_RESPONSE_CHARS) throw new Error('AI 响应超过大小限制')
        emit('ai:delta', { requestId, text })
      } catch (error) {
        if (error instanceof Error && error.message === 'AI 响应超过大小限制') throw error
        // Ignore provider-specific non-JSON keepalive lines.
      }
    }
    while (true) {
      const part = await reader.read()
      if (part.done) break
      buffer += decoder.decode(part.value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) consume(line)
    }
    if (buffer) consume(buffer)
    emit('ai:completed', { requestId })
  } catch (error) {
    if (controller.signal.aborted) {
      emit('ai:cancelled', { requestId })
    } else {
      const message = error instanceof Error ? error.message : 'AI 请求失败'
      emitError(requestId, 'REQUEST_FAILED', message)
    }
  } finally {
    active.delete(requestId)
    void started
  }
}

export function cancelAi(requestId: string): void {
  active.get(requestId)?.abort()
}
