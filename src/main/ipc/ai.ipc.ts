import { z } from 'zod'
import { handle } from './registry'
import { cancelAi, chatAi, discoverAiModels, testAiConnection, testAiImageCapability } from '../services/aiService'
import { deleteAiProfile, listAiProfiles, saveAiProfile } from '../services/aiProfiles'

const id = z.string().min(1).max(200)
const endpointDraft = z.object({
  profileId: id.optional(),
  baseUrl: z.string().trim().min(1).max(2048).optional(),
  token: z.string().max(4096).optional()
})
const draft = z.object({
  expectedUpdatedAt: z.number().int().nonnegative().optional(),
  id: id.optional(),
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().min(1).max(2048),
  model: z.string().trim().min(1).max(200),
  enabled: z.boolean().optional(),
  token: z.string().max(4096).optional(),
  clearToken: z.boolean().optional()
})
const contentPart = z.union([
  z.object({ type: z.literal('text'), text: z.string().max(32_768) }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().max(12 * 1024 * 1024), detail: z.enum(['low', 'high', 'auto']).optional() }) })
])
const message = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([z.string().max(32_768), z.array(contentPart).max(32)])
})

export function registerAiIpc(): void {
  handle('ai:profiles:list', () => listAiProfiles())
  handle('ai:profiles:save', (value) => saveAiProfile(value), z.tuple([draft]))
  handle('ai:profiles:delete', (profileId) => deleteAiProfile(profileId), z.tuple([id]))
  handle('ai:connectionTest', ({ profileId }) => testAiConnection(profileId), z.tuple([z.object({ profileId: id })]))
  handle('ai:models:discover', (request) => discoverAiModels(request), z.tuple([endpointDraft]))
  handle('ai:model:capabilityTest', (request) => testAiImageCapability(request), z.tuple([endpointDraft.extend({ model: z.string().trim().min(1).max(200) })]))
  handle('ai:chat', ({ requestId, profileId, messages, stream }) => chatAi(requestId, profileId, messages, stream ?? true), z.tuple([
    z.object({ requestId: id, profileId: id, messages: z.array(message).min(1).max(64), stream: z.boolean().optional() })
  ]))
  handle('ai:cancel', (requestId) => cancelAi(requestId), z.tuple([id]))
}
