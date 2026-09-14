import { net } from 'electron'
import { emit } from '../ipc/registry'
import { getAiProfile, getAiToken, normalizeAiBaseUrl } from './aiProfiles'
import { getSettings } from './settings'
import { parseAiModels } from './aiModels'
import { t } from './i18n'
import type { AiChatMessage, AiConnectionTestResult, AiModelInfo, AiModelEndpointDraft, AiImageCapabilityTestResult } from '@shared/types'

const MAX_MESSAGES = 64
const MAX_CONTENT_CHARS = 32_768
const MAX_RESPONSE_CHARS = 1_000_000
const REQUEST_TIMEOUT_MS = 120_000
const MAX_ACTIVE_REQUESTS = 4
const MAX_MODEL_RESPONSE_BYTES = 4 * 1024 * 1024
const MODEL_TEST_TIMEOUT_MS = 30_000
let activeModelTests = 0
const active = new Map<string, AbortController>()
const CAPABILITY_PROBE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

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
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error(t('aiCapabilities.responseTooLarge'))
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > limit) throw new Error(t('aiCapabilities.responseTooLarge'))
      output += decoder.decode(part.value, { stream: true })
    }
    return output + decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function resolveModelEndpoint(input: AiModelEndpointDraft): { baseUrl: string; token: string } {
  const profile = input.profileId ? getAiProfile(input.profileId) : undefined
  if (input.profileId && !profile) throw new Error(t('aiCapabilities.profileMissing'))
  const baseUrl = normalizeAiBaseUrl(input.baseUrl ?? profile?.baseUrl ?? '')
  const typedToken = input.token?.trim()
  // A saved credential must not be forwarded to a newly typed endpoint.
  if (!typedToken && profile && normalizeAiBaseUrl(profile.baseUrl) !== baseUrl) {
    throw new Error(t('aiCapabilities.endpointChanged'))
  }
  const token = typedToken || (profile ? getAiToken(profile.id).token : '')
  if (!token) throw new Error(t('aiCapabilities.credentialsRequired'))
  return { baseUrl, token }
}

/** Keep timeout/concurrency guards alive until the entire body has been consumed. */
async function withModelTest<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!getSettings().aiAssistantEnabled) throw new Error(t('aiCapabilities.assistantDisabled'))
  if (activeModelTests >= 2) throw new Error(t('aiCapabilities.busy'))
  activeModelTests++
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODEL_TEST_TIMEOUT_MS)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
    activeModelTests--
  }
}

export async function discoverAiModels(input: AiModelEndpointDraft): Promise<AiModelInfo[]> {
  return withModelTest(async (signal) => {
    const { baseUrl, token } = resolveModelEndpoint(input)
    let response: Response
    let body: string
    try {
      response = await net.fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal, redirect: 'error'
      })
      body = await readLimited(response, MAX_MODEL_RESPONSE_BYTES)
    } catch {
      throw new Error(signal.aborted ? t('aiCapabilities.discoveryTimeout') : t('aiCapabilities.discoveryFailed'))
    }
    if (!response.ok) throw new Error(`${errorForStatus(response.status)}（HTTP ${response.status}）`)
    let parsed: unknown
    try { parsed = JSON.parse(body) as unknown } catch { throw new Error(t('aiCapabilities.invalidList')) }
    const models = parseAiModels(parsed)
    if (models.length === 0) throw new Error(t('aiCapabilities.noModels'))
    return models
  })
}

async function request(profileId: string, messages: AiChatMessage[], stream: boolean, signal: AbortSignal): Promise<Response> {
  const { profile, token } = getAiToken(profileId)
  return net.fetch(endpoint(profile.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream, application/json' : 'application/json' },
    body: JSON.stringify({ model: profile.model, messages, stream, temperature: 0.7, max_tokens: 4096 }),
    signal
  })
}

/** Explicit user action: tests image request compatibility, not whether a gateway really decoded it. */
export async function testAiImageCapability(input: AiModelEndpointDraft & { model: string }): Promise<AiImageCapabilityTestResult> {
  const model = input.model.trim()
  if (!model || model.length > 200) throw new Error(t('aiCapabilities.invalidModel'))
  return withModelTest(async (signal) => {
    const { baseUrl, token } = resolveModelEndpoint(input)
    let response: Response
    let body: string
    try {
      response = await net.fetch(endpoint(baseUrl), {
        method: 'POST', signal, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model, stream: false, max_tokens: 64,
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'Describe the attached test image in a few words.' },
            { type: 'image_url', image_url: { url: CAPABILITY_PROBE_PNG, detail: 'low' } }
          ] }]
        })
      })
      body = await readLimited(response, 64 * 1024)
    } catch {
      // Never expose fetch exceptions or raw provider bodies, which may echo credentials.
      throw new Error(signal.aborted ? t('aiCapabilities.probeTimeout') : t('aiCapabilities.probeFailed'))
    }
    const base = { model, httpStatus: response.status }
    if ([401, 403, 404, 429].includes(response.status) || response.status >= 500) {
      throw new Error(`${errorForStatus(response.status)}（HTTP ${response.status}）`)
    }
    let data: { error?: { code?: unknown; message?: unknown }; choices?: Array<{ message?: { content?: unknown } }> } | undefined
    try { data = JSON.parse(body) } catch { /* An HTML success page is not a successful model response. */ }
    const content = data?.choices?.[0]?.message?.content
    if (response.ok && !data?.error && typeof content === 'string' && content.trim()) {
      return { ...base, image: 'yes', outcome: 'accepted', message: t('aiCapabilities.acceptedMessage') }
    }
    const code = data?.error?.code
    const message = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 4000) : ''
    const unsupported = ['image_input_not_supported', 'unsupported_image_input', 'vision_not_supported'].includes(String(code)) ||
      /(?:model[^.\n]{0,100}(?:does not|doesn't|cannot|can't) support (?:image|vision|multimodal)|image_url is only supported by certain models|(?:该|当前|此)模型不支持(?:图片|图像|视觉|多模态))/.test(message.toLowerCase())
    if ([400, 415, 422].includes(response.status) && unsupported) {
      return { ...base, image: 'no', outcome: 'unsupported', message: t('aiCapabilities.unsupportedMessage') }
    }
    return { ...base, image: 'unknown', outcome: 'inconclusive', message: t('aiCapabilities.inconclusiveMessage', { status: response.status }) }
  })
}

async function assertResponse(response: Response): Promise<void> {
  if (response.ok) return
  throw new Error(errorForStatus(response.status))
}

export async function testAiConnection(profileId: string): Promise<AiConnectionTestResult> {
  return withModelTest(async (signal) => {
    const { profile, token } = getAiToken(profileId)
    // A monotonic clock avoids incorrect timings if the system clock changes.
    const started = performance.now()
    let response: Response
    try {
      response = await net.fetch(endpoint(profile.baseUrl), {
        method: 'POST', signal, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: profile.model, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 64 })
      })
      // Include model processing and response transfer, not just receipt of HTTP headers.
      // The shared timeout stays active while the body is being read.
      await readLimited(response, 64 * 1024)
    } catch {
      throw new Error(signal.aborted ? t('aiConnectionTest.timeout') : t('aiConnectionTest.failed'))
    }
    await assertResponse(response)
    return { ok: true, model: profile.model, latencyMs: Math.max(0, Math.round(performance.now() - started)) }
  })
}

function emitError(requestId: string, code: string, message: string): void {
  emit('ai:error', { requestId, code, message })
}

function responseText(body: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(body) as unknown } catch { throw new Error('AI 服务返回的 JSON 无效') }
  const content = (parsed as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: unknown } })?.choices?.[0]?.message?.content
  if (typeof content === 'string' && content.length > 0) return content
  if (Array.isArray(content)) {
    const text = content.filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === 'object').map((part) => typeof part.text === 'string' ? part.text : '').join('')
    if (text) return text
  }
  throw new Error(typeof (parsed as { error?: { message?: unknown } })?.error?.message === 'string' ? 'AI 服务返回错误响应' : 'AI 服务未返回有效回答')
}

export async function chatAi(requestId: string, profileId: string, messages: AiChatMessage[], stream = true): Promise<void> {
  if (!getSettings().aiAssistantEnabled) throw new Error('AI 助手尚未启用，请先在设置中开启')
  if (active.has(requestId)) throw new Error('AI 请求已存在')
  if (active.size >= MAX_ACTIVE_REQUESTS) throw new Error('AI 请求过多，请等待当前请求完成')
  validateMessages(messages)
  const controller = new AbortController()
  active.set(requestId, controller)
  const started = Date.now()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await request(profileId, messages, stream, controller.signal)
    await assertResponse(response)
    if (!stream) {
      const body = await readLimited(response, MAX_RESPONSE_CHARS)
      const text = responseText(body)
      emit('ai:delta', { requestId, text })
      emit('ai:completed', { requestId })
      return
    }
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
    clearTimeout(timer)
    active.delete(requestId)
    void started
  }
}

export function cancelAi(requestId: string): void {
  active.get(requestId)?.abort()
}
