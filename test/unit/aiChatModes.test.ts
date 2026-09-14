import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderProfile } from '../../src/shared/types'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), profile: vi.fn(), token: vi.fn(), emit: vi.fn() }))
vi.mock('electron', async (original) => ({ ...await original<typeof import('electron')>(), net: { fetch: mocks.fetch } }))
vi.mock('../../src/main/services/aiProfiles', async (original) => ({ ...await original<typeof import('../../src/main/services/aiProfiles')>(), getAiProfile: mocks.profile, getAiToken: mocks.token }))
vi.mock('../../src/main/services/settings', () => ({ getSettings: () => ({ aiAssistantEnabled: true, language: 'zh-CN' }) }))
vi.mock('../../src/main/ipc/registry', () => ({ emit: mocks.emit }))
import { chatAi } from '../../src/main/services/aiService'

const profile: AiProviderProfile = { id: 'p', name: 'p', baseUrl: 'https://api.example/v1', model: 'model', enabled: true, hasToken: true, createdAt: 1, updatedAt: 1 }
const messages = [{ role: 'user' as const, content: 'hello' }]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.profile.mockReturnValue(profile)
  mocks.token.mockReturnValue({ profile, token: 'secret' })
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }), { status: 200 }))
})

describe('AI chat response modes', () => {
  it('parses a non-stream JSON response and emits one delta', async () => {
    await chatAi('req-nonstream', profile.id, messages, false)
    const init = mocks.fetch.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({ model: profile.model, stream: false })
    expect(mocks.emit).toHaveBeenNthCalledWith(1, 'ai:delta', { requestId: 'req-nonstream', text: 'answer' })
    expect(mocks.emit).toHaveBeenNthCalledWith(2, 'ai:completed', { requestId: 'req-nonstream' })
  })

  it('keeps the existing SSE delta behavior for stream mode', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"part"}}]}\n\ndata: [DONE]\n\n`)); controller.close() } })
    mocks.fetch.mockResolvedValue(new Response(body, { status: 200 }))
    await chatAi('req-stream', profile.id, messages, true)
    const init = mocks.fetch.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({ model: profile.model, stream: true })
    expect(mocks.emit).toHaveBeenCalledWith('ai:delta', { requestId: 'req-stream', text: 'part' })
    expect(mocks.emit).toHaveBeenCalledWith('ai:completed', { requestId: 'req-stream' })
  })

  it('reports malformed non-stream bodies instead of completing empty', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }))
    await chatAi('req-invalid', profile.id, messages, false)
    expect(mocks.emit).toHaveBeenCalledWith('ai:error', expect.objectContaining({ requestId: 'req-invalid' }))
    expect(mocks.emit).not.toHaveBeenCalledWith('ai:completed', { requestId: 'req-invalid' })
  })
})
