import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  RDP_ERROR_CODES,
  RDP_SESSION_STATES,
  clampRdpDisplaySize,
  isRdpPortFrameMessage,
  parseRdpFrameV1
} from '../../src/shared/types'
import {
  rdpDisplaySchema,
  rdpInputSchema,
  rdpSessionIdSchema
} from '../../src/main/ipc/rdp.ipc'

describe('RDP shared runtime contract', () => {
  it('accepts only an exact transferable frame shape', () => {
    const payload = new ArrayBuffer(16 + 24 + 640 * 480 * 4)
    const view = new DataView(payload)
    view.setUint32(0, 640, true)
    view.setUint32(4, 480, true)
    view.setUint32(8, 7, true)
    view.setUint16(12, 1, true)
    view.setUint32(24, 640, true)
    view.setUint32(28, 480, true)
    view.setUint32(32, 640 * 4, true)
    view.setUint32(36, 640 * 480 * 4, true)
    const valid = {
      kind: 'frame', sequence: 7, canvasWidth: 640, canvasHeight: 480,
      buffer: payload.slice(16)
    }
    expect(isRdpPortFrameMessage(valid)).toBe(true)
    expect(isRdpPortFrameMessage({ ...valid, kind: 'frameAck' })).toBe(false)
    expect(isRdpPortFrameMessage({ ...valid, buffer: new Uint8Array(16) })).toBe(false)
    expect(isRdpPortFrameMessage({ ...valid, sequence: -1 })).toBe(false)
    expect(isRdpPortFrameMessage({ ...valid, canvasWidth: 319 })).toBe(false)
    expect(isRdpPortFrameMessage({ ...valid, canvasWidth: 8192, canvasHeight: 8192 })).toBe(false)
    expect(isRdpPortFrameMessage({ ...valid, unexpected: true })).toBe(false)
  })

  it('accepts only the canonical complete rdp-frame-v1 payload', () => {
    const payload = new Uint8Array(16 + 24 + 4)
    const view = new DataView(payload.buffer)
    view.setUint32(0, 320, true)
    view.setUint32(4, 320, true)
    view.setUint32(8, 11, true)
    view.setUint16(12, 1, true)
    view.setUint32(24, 1, true)
    view.setUint32(28, 1, true)
    view.setUint32(32, 4, true)
    view.setUint32(36, 4, true)

    const parsed = parseRdpFrameV1(payload)
    expect(parsed).toMatchObject({ sequence: 11, canvasWidth: 320, canvasHeight: 320 })
    expect(parsed?.data).toEqual(payload.subarray(16))
    expect(parseRdpFrameV1(payload.subarray(16))).toBeNull()
    expect(parseRdpFrameV1(payload.subarray(0, payload.length - 1))).toBeNull()
  })

  it('clamps both edges, dpi and total pixels deterministically', () => {
    expect(clampRdpDisplaySize({ width: 1, height: 2, dpi: 1 })).toEqual({ width: 320, height: 320, dpi: 96 })
    const large = clampRdpDisplaySize({ width: 8192, height: 8192, dpi: 500 })
    expect(large.width * large.height).toBeLessThanOrEqual(16_777_216)
    expect(large.dpi).toBe(384)
  })

  it('freezes the public state machine and stable error codes', () => {
    expect(RDP_SESSION_STATES).toEqual([
      'starting', 'handshaking', 'connecting', 'authenticating', 'verifying',
      'ready', 'reconnecting', 'failed', 'closing', 'closed'
    ])
    expect(RDP_ERROR_CODES).toEqual([
      'WORKER_MISSING', 'WORKER_START_FAILED', 'PROTOCOL_MISMATCH', 'PROTOCOL_ERROR',
      'AUTH_FAILED', 'CERTIFICATE_REJECTED', 'UNSUPPORTED', 'NETWORK_ERROR',
      'WORKER_CRASHED', 'SESSION_NOT_READY', 'CANCELED'
    ])
  })

  it('rejects invalid display, input and session-id values at the IPC boundary', () => {
    expect(rdpDisplaySchema.safeParse({ width: 1920, height: 1080, dpi: 96 }).success).toBe(true)
    expect(rdpDisplaySchema.safeParse({ width: 8192, height: 8192, dpi: 96 }).success).toBe(false)
    expect(rdpInputSchema.safeParse({ kind: 'key', scanCode: 30, pressed: true, unicode: 0x61 }).success).toBe(true)
    expect(rdpInputSchema.safeParse({ kind: 'key', scanCode: 30, pressed: true, unicode: 0xd800 }).success).toBe(false)
    expect(rdpInputSchema.safeParse({ kind: 'pointer', x: -1, y: 0, buttons: 0 }).success).toBe(false)
    expect(rdpSessionIdSchema.safeParse('').success).toBe(false)
    expect(rdpSessionIdSchema.safeParse('x'.repeat(201)).success).toBe(false)
  })

  it('keeps RDP on typed preload and sender-checked, validated main handlers', () => {
    const preload = readFileSync('src/preload/index.ts', 'utf8')
    const rdpIpc = readFileSync('src/main/ipc/rdp.ipc.ts', 'utf8')
    const registry = readFileSync('src/main/ipc/registry.ts', 'utf8')
    const sessionStore = readFileSync('src/renderer/src/stores/useSessionStore.ts', 'utf8')
    const rendererFiles = [
      'src/renderer/src/features/sessions/RdpPane.tsx',
      'src/renderer/src/stores/useSessionStore.ts'
    ].map((path) => readFileSync(path, 'utf8')).join('\n')

    expect(preload).toContain("contextBridge.exposeInMainWorld('ofs', ofs)")
    expect(preload).toContain('ipcRenderer.postMessage(RDP_PORT_CHANNEL')
    expect(preload).not.toContain("exposeInMainWorld('ipcRenderer'")
    expect(rendererFiles).not.toContain('ipcRenderer')
    expect(sessionStore).toMatch(/SessionTabKind\s*=\s*[^\n]*'rdp'/)
    expect(registry).toMatch(/function onPort[\s\S]*?assertTrustedSender\(event\)[\s\S]*?event\.ports/)

    for (const channel of [
      'open', 'close', 'reconnect', 'input', 'resize',
      'clipboardSet', 'clipboardGet', 'systemFallback'
    ]) {
      expect(rdpIpc).toMatch(new RegExp(`handle\\('rdp:${channel}'[\\s\\S]*?z\\.tuple`))
    }
    expect(rdpIpc).toMatch(/onPort\(RDP_PORT_CHANNEL[\s\S]*?safeParse\(payload\)/)
    expect(sessionStore).not.toContain("ofs.on('rdp:frame'")
    expect(sessionStore).not.toContain('latestRdpFrame.set')
  })
})
