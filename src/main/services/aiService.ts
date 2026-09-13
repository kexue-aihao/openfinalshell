import { net } from 'electron'
import { emit } from '../ipc/registry'
import { getAiToken } from './aiProfiles'
import { getSettings } from './settings'
import type { AiChatMessage } from '@shared/types'

const MAX_MESSAGES = 64
const MAX_CONTENT_CHARS = 32_768
const MAX_RESPONSE_CHARS = 1_000_000
const REQUEST_TIMEOUT_MS = 120_000
const MAX_ACTIVE_REQUESTS = 4
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
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > MAX_CONTENT_CHARS) {
      throw new Error('AI 消息格式或长度无效')
    }
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
