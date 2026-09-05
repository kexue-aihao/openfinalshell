import { z } from 'zod'
import { handle, onPort } from './registry'
import { rdpSessionManager } from '../rdp/RdpSessionManager'
import { RDP_PORT_CHANNEL } from '@shared/ipc'
import { RDP_MAX_DISPLAY_PIXELS } from '@shared/types'

export const rdpSessionIdSchema = z.string().min(1).max(200)

export const rdpDisplaySchema = z.object({
  width: z.number().int().min(320).max(8192),
  height: z.number().int().min(320).max(8192),
  dpi: z.number().int().min(96).max(384)
}).refine(({ width, height }) => width * height <= RDP_MAX_DISPLAY_PIXELS, {
  message: 'RDP display exceeds the pixel limit'
})

const unicodeScalarSchema = z.number().int().min(0).max(0x10ffff).refine(
  (value) => value < 0xd800 || value > 0xdfff,
  { message: 'RDP unicode input must be a Unicode scalar value' }
)

export const rdpInputSchema = z.union([
  z.object({ kind: z.literal('key'), scanCode: z.number().int().min(0).max(255), pressed: z.boolean(), extended: z.boolean().optional(), unicode: unicodeScalarSchema.optional() }),
  z.object({ kind: z.literal('pointer'), x: z.number().int().min(0).max(8192), y: z.number().int().min(0).max(8192), buttons: z.number().int().min(0).max(255), wheelX: z.number().int().min(-10000).max(10000).optional(), wheelY: z.number().int().min(-10000).max(10000).optional() })
])

export function registerRdpIpc(): void {
  handle('rdp:open', ({ profileId, display }) => rdpSessionManager.open(profileId, display), z.tuple([z.object({ profileId: z.string().min(1).max(200), display: rdpDisplaySchema })]))
  handle('rdp:close', (sessionId) => rdpSessionManager.close(sessionId), z.tuple([rdpSessionIdSchema]))
  handle('rdp:reconnect', (sessionId) => rdpSessionManager.reconnect(sessionId), z.tuple([rdpSessionIdSchema]))
  handle('rdp:input', ({ sessionId, input }) => rdpSessionManager.input(sessionId, input), z.tuple([z.object({ sessionId: rdpSessionIdSchema, input: rdpInputSchema })]))
  handle('rdp:resize', ({ sessionId, display }) => rdpSessionManager.resize(sessionId, display), z.tuple([z.object({ sessionId: rdpSessionIdSchema, display: rdpDisplaySchema })]))
  handle('rdp:clipboardSet', ({ sessionId, text }) => rdpSessionManager.clipboardSet(sessionId, text), z.tuple([z.object({ sessionId: rdpSessionIdSchema, text: z.string().max(1_000_000) })]))
  handle('rdp:clipboardGet', (sessionId) => rdpSessionManager.clipboardGet(sessionId), z.tuple([rdpSessionIdSchema]))
  handle('rdp:systemFallback', (sessionId) => rdpSessionManager.systemFallback(sessionId), z.tuple([rdpSessionIdSchema]))
  onPort(RDP_PORT_CHANNEL, (_event, payload, port) => {
    const parsed = z.object({ sessionId: rdpSessionIdSchema }).safeParse(payload)
    if (!parsed.success) {
      port.close()
      return
    }
    rdpSessionManager.attachPort(parsed.data.sessionId, port)
  })
}
