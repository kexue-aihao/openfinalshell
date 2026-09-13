import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderProfile } from '../../src/shared/types'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), profile: vi.fn(), token: vi.fn() }))
vi.mock('electron', async (original) => ({ ...await original<typeof import('electron')>(), net: { fetch: mocks.fetch } }))
vi.mock('../../src/main/services/aiProfiles', async (original) => ({
  ...await original<typeof import('../../src/main/services/aiProfiles')>(), getAiProfile: mocks.profile, getAiToken: mocks.token
}))
vi.mock('../../src/main/services/settings', () => ({ getSettings: () => ({ aiAssistantEnabled: true, language: 'zh-CN' }) }))
import { discoverAiModels, testAiConnection, testAiImageCapability } from '../../src/main/services/aiService'

const profile: AiProviderProfile = { id: 'saved', name: 'saved', baseUrl: 'https://api.deepseek.com/v1', model: 'old-model', enabled: true, hasToken: true, createdAt: 1, updatedAt: 1 }
const draft = { profileId: profile.id, model: 'selected-model' }
const success = { choices: [{ message: { content: 'A small test image.' } }] }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.profile.mockReturnValue(profile)
  mocks.token.mockReturnValue({ profile, token: 'saved-test-secret' })
  mocks.fetch.mockImplementation(async () => json(success))
})
afterEach(() => vi.useRealTimers())

describe('connection test response time', () => {
  it('measures the complete response rather than just headers, without returning credentials or content', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let body!: ReadableStreamDefaultController<Uint8Array>
    mocks.fetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 125))
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }))
    })
    let completed = false
    const pending = testAiConnection(profile.id).then((value) => { completed = true; return value })
    await vi.advanceTimersByTimeAsync(125)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(203)
    body.enqueue(new TextEncoder().encode(JSON.stringify(success)))
    body.close()
    expect(await pending).toEqual({ ok: true, model: profile.model, latencyMs: 328 })
    expect(mocks.fetch.mock.calls[0][0]).toBe(`${profile.baseUrl}/chat/completions`)
  })

  it('clears a stalled body on timeout and allows another connection test', async () => {
    vi.useFakeTimers()
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener('abort', () => controller.error(new Error('aborted'))) }
    })))
    const pending = expect(testAiConnection(profile.id)).rejects.toThrow('连接测试超时')
    await vi.advanceTimersByTimeAsync(30000)
    await pending
    mocks.fetch.mockResolvedValue(json(success))
    expect(await testAiConnection(profile.id)).toMatchObject({ ok: true, latencyMs: expect.any(Number) })
  })

  it('does not report a successful latency on HTTP or network failure', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ error: { message: 'saved-test-secret' } }, 401))
    await expect(testAiConnection(profile.id)).rejects.toThrow('AI Token 无效或已过期')
    mocks.fetch.mockRejectedValueOnce(new Error('saved-test-secret'))
    await expect(testAiConnection(profile.id)).rejects.toThrow('连接测试失败，请检查网络、接口地址和响应大小。')
  })
})

describe('explicit image input request test', () => {
  it('uses the selected draft model, bounds output, and returns no credentials or provider content', async () => {
    const result = await testAiImageCapability(draft)
    expect(result).toMatchObject({ model: draft.model, image: 'yes', outcome: 'accepted', httpStatus: 200 })
    const [url, init] = mocks.fetch.mock.calls[0]
    expect(url).toBe(`${profile.baseUrl}/chat/completions`)
    expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer saved-test-secret' } })
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ model: draft.model, stream: false, max_tokens: 64 })
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/)
    expect(JSON.stringify(result)).not.toMatch(/saved-test-secret|A small test image/)
  })

  it('allows unsaved/replacement tokens without trying to decrypt an old token', async () => {
    mocks.token.mockImplementation(() => { throw new Error('old token missing') })
    await testAiImageCapability({ ...draft, token: 'new-test-token', baseUrl: 'https://gateway.example/tenant/v1' })
    expect(mocks.token).not.toHaveBeenCalled()
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://gateway.example/tenant/v1/chat/completions')
    mocks.fetch.mockResolvedValue(json({ data: [{ id: 'new-model' }] }))
    expect(await discoverAiModels({ token: 'new-test-token', baseUrl: 'https://gateway.example/v1' })).toHaveLength(1)
  })

  it('never forwards saved credentials to an edited endpoint', async () => {
    await expect(testAiImageCapability({ ...draft, baseUrl: 'https://different.example/v1' })).rejects.toThrow(/重新填写 Token/)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.token).not.toHaveBeenCalled()
  })

  it.each([400, 415, 422])('reports explicit image rejection for HTTP %s', async (status) => {
    mocks.fetch.mockResolvedValue(json({ error: { message: 'This model does not support image input.' } }, status))
    expect(await testAiImageCapability(draft)).toMatchObject({ image: 'no', outcome: 'unsupported', httpStatus: status })
  })

  it.each([400, 415, 422])('keeps parameter and format failures inconclusive for HTTP %s', async (status) => {
    mocks.fetch.mockResolvedValue(json({ error: { message: 'Unsupported max_tokens value; invalid image format; secret saved-test-secret' } }, status))
    const result = await testAiImageCapability(draft)
    expect(result).toMatchObject({ image: 'unknown', outcome: 'inconclusive' })
    expect(result.message).not.toContain('saved-test-secret')
  })

  it.each([{}, { error: { message: 'error' } }, { choices: [{ message: { content: '' } }] }, null, '<html>ok</html>'])('does not treat a malformed HTTP 200 body as success: %j', async (payload) => {
    mocks.fetch.mockResolvedValue(json(payload))
    expect(await testAiImageCapability(draft)).toMatchObject({ image: 'unknown', outcome: 'inconclusive' })
  })

  it.each([401, 403, 404, 429, 500])('keeps HTTP %s separate from capability conclusions', async (status) => {
    mocks.fetch.mockResolvedValue(json({ error: { message: 'saved-test-secret' } }, status))
    await expect(testAiImageCapability(draft)).rejects.toThrow(`HTTP ${status}`)
  })

  it('redacts transport errors and cancels oversized streaming replies', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('request contains saved-test-secret'))
    await expect(testAiImageCapability(draft)).rejects.toThrow('图片输入检测失败，请检查网络、接口地址和响应大小')
    const cancel = vi.fn()
    mocks.fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65537)) }, cancel
    })))
    await expect(testAiImageCapability(draft)).rejects.toThrow(/响应大小/)
    expect(cancel).toHaveBeenCalled()
    expect(await testAiImageCapability(draft)).toMatchObject({ outcome: 'accepted' })
  })

  it('times out stalled response bodies, limits concurrency and allows retry', async () => {
    vi.useFakeTimers()
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener('abort', () => controller.error(new Error('aborted'))) }
    })))
    const first = expect(testAiImageCapability(draft)).rejects.toThrow(/超时/)
    const second = expect(testAiImageCapability(draft)).rejects.toThrow(/超时/)
    await expect(testAiImageCapability(draft)).rejects.toThrow(/正在进行/)
    await vi.advanceTimersByTimeAsync(30000)
    await Promise.all([first, second])
    mocks.fetch.mockResolvedValue(json(success))
    expect(await testAiImageCapability(draft)).toMatchObject({ outcome: 'accepted' })
  })
})
