import { z } from 'zod'
import { handle, onPort, onSend } from './registry'
import { rdpSessionManager } from '../rdp/RdpSessionManager'
import { RDP_PORT_CHANNEL } from '@shared/ipc'
import { RDP_MAX_DISPLAY_PIXELS } from '@shared/types'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('rdp-ipc')

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

/**
 * Hot-path validation for one-way input IPC. The regular invoke path uses
 * Zod, but allocating a full parse result for every mouse event adds visible
 * latency. Keep this equivalent boundary check allocation-free.
 */
function isRdpInputEnvelope(value: unknown): value is { sessionId: string; input: z.infer<typeof rdpInputSchema> } {
  if (!isRecord(value) || typeof value.sessionId !== 'string' ||
      value.sessionId.length < 1 || value.sessionId.length > 200 || !isRecord(value.input)) return false
  const input = value.input
  if (input.kind === 'key') {
    if (!isIntegerInRange(input.scanCode, 0, 255) || typeof input.pressed !== 'boolean') return false
    if (input.extended !== undefined && typeof input.extended !== 'boolean') return false
    if (input.unicode !== undefined &&
        (!isIntegerInRange(input.unicode, 0, 0x10ffff) ||
         (input.unicode >= 0xd800 && input.unicode <= 0xdfff))) return false
    return true
  }
  if (input.kind !== 'pointer' || !isIntegerInRange(input.x, 0, 8192) ||
      !isIntegerInRange(input.y, 0, 8192) || !isIntegerInRange(input.buttons, 0, 255)) return false
  return (input.wheelX === undefined || isIntegerInRange(input.wheelX, -10000, 10000)) &&
    (input.wheelY === undefined || isIntegerInRange(input.wheelY, -10000, 10000))
}

export function registerRdpIpc(): void {
  handle('rdp:open', ({ profileId, display }) => rdpSessionManager.open(profileId, display), z.tuple([z.object({ profileId: z.string().min(1).max(200), display: rdpDisplaySchema })]))
  handle('rdp:close', (sessionId) => rdpSessionManager.close(sessionId), z.tuple([rdpSessionIdSchema]))
  handle('rdp:reconnect', (sessionId) => rdpSessionManager.reconnect(sessionId), z.tuple([rdpSessionIdSchema]))
  onSend('rdp:input', (payload) => {
    if (!isRdpInputEnvelope(payload)) return
    try {
      rdpSessionManager.input(payload.sessionId, payload.input)
    } catch (error) {
      // A one-way input can arrive just after a tab starts reconnecting. It is
      // stale user input, not a main-process fault, and must not escape an
      // ipcMain.on callback as an uncaught exception.
      if (!(error instanceof Error) || error.message !== 'SESSION_NOT_READY') {
        log.warn(`RDP input dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
  handle('rdp:resize', ({ sessionId, display }) => rdpSessionManager.resize(sessionId, display), z.tuple([z.object({ sessionId: rdpSessionIdSchema, display: rdpDisplaySchema })]))
  handle('rdp:clipboardSet', ({ sessionId, text }) => rdpSessionManager.clipboardSet(sessionId, text), z.tuple([z.object({ sessionId: rdpSessionIdSchema, text: z.string().max(1_000_000) })]))
  handle('rdp:clipboardFilesSet', ({ sessionId, files }) => rdpSessionManager.clipboardFilesSet(sessionId, files), z.tuple([z.object({
    sessionId: rdpSessionIdSchema,
    files: z.array(z.string().min(1).max(32_768)).min(1).max(64)
  })]))
  handle('rdp:clipboardLocalFiles', (sessionId) => rdpSessionManager.clipboardLocalFiles(sessionId), z.tuple([rdpSessionIdSchema]))
  handle('rdp:clipboardGet', (sessionId) => rdpSessionManager.clipboardGet(sessionId), z.tuple([rdpSessionIdSchema]))
  handle('rdp:clipboardSync', ({ sessionId, enabled }) => rdpSessionManager.clipboardSync(sessionId, enabled), z.tuple([z.object({ sessionId: rdpSessionIdSchema, enabled: z.boolean() })]))
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
