import { useEffect, useRef } from 'react'
import { App as AntdApp, Button, Empty, Space, Spin } from 'antd'
import { MonitorUp, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ofs } from '@/ipc/api'
import { useSessionStore, type SessionTab } from '@/stores/useSessionStore'
import {
  RDP_MAX_DISPLAY_EDGE,
  RDP_MAX_DISPLAY_PIXELS,
  RDP_MIN_DISPLAY_EDGE,
  clampRdpDisplaySize,
  type RdpFrame,
  type RdpInput,
  type RdpPortMessage
} from '@shared/types'
import styles from './RdpPane.module.css'

interface Props { tab: SessionTab; active: boolean }

interface DirtyRect {
  x: number
  y: number
  width: number
  height: number
  stride: number
  data: Uint8Array
}

interface QueuedFrame {
  frame: RdpFrame
  ack?: () => void
}

const RECT_HEADER_SIZE = 24
const MAX_RECT_COUNT = 1024
const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Set-1 scan codes keyed by the physical DOM KeyboardEvent.code value. */
const RDP_SCANCODES: Readonly<Record<string, { scanCode: number; extended?: true }>> = {
  Escape: { scanCode: 0x01 }, Digit1: { scanCode: 0x02 }, Digit2: { scanCode: 0x03 },
  Digit3: { scanCode: 0x04 }, Digit4: { scanCode: 0x05 }, Digit5: { scanCode: 0x06 },
  Digit6: { scanCode: 0x07 }, Digit7: { scanCode: 0x08 }, Digit8: { scanCode: 0x09 },
  Digit9: { scanCode: 0x0a }, Digit0: { scanCode: 0x0b }, Minus: { scanCode: 0x0c },
  Equal: { scanCode: 0x0d }, Backspace: { scanCode: 0x0e }, Tab: { scanCode: 0x0f },
  KeyQ: { scanCode: 0x10 }, KeyW: { scanCode: 0x11 }, KeyE: { scanCode: 0x12 },
  KeyR: { scanCode: 0x13 }, KeyT: { scanCode: 0x14 }, KeyY: { scanCode: 0x15 },
  KeyU: { scanCode: 0x16 }, KeyI: { scanCode: 0x17 }, KeyO: { scanCode: 0x18 },
  KeyP: { scanCode: 0x19 }, BracketLeft: { scanCode: 0x1a }, BracketRight: { scanCode: 0x1b },
  Enter: { scanCode: 0x1c }, ControlLeft: { scanCode: 0x1d }, KeyA: { scanCode: 0x1e },
  KeyS: { scanCode: 0x1f }, KeyD: { scanCode: 0x20 }, KeyF: { scanCode: 0x21 },
  KeyG: { scanCode: 0x22 }, KeyH: { scanCode: 0x23 }, KeyJ: { scanCode: 0x24 },
  KeyK: { scanCode: 0x25 }, KeyL: { scanCode: 0x26 }, Semicolon: { scanCode: 0x27 },
  Quote: { scanCode: 0x28 }, Backquote: { scanCode: 0x29 }, ShiftLeft: { scanCode: 0x2a },
  Backslash: { scanCode: 0x2b }, KeyZ: { scanCode: 0x2c }, KeyX: { scanCode: 0x2d },
  KeyC: { scanCode: 0x2e }, KeyV: { scanCode: 0x2f }, KeyB: { scanCode: 0x30 },
  KeyN: { scanCode: 0x31 }, KeyM: { scanCode: 0x32 }, Comma: { scanCode: 0x33 },
  Period: { scanCode: 0x34 }, Slash: { scanCode: 0x35 }, ShiftRight: { scanCode: 0x36 },
  NumpadMultiply: { scanCode: 0x37 }, AltLeft: { scanCode: 0x38 }, Space: { scanCode: 0x39 },
  CapsLock: { scanCode: 0x3a }, F1: { scanCode: 0x3b }, F2: { scanCode: 0x3c },
  F3: { scanCode: 0x3d }, F4: { scanCode: 0x3e }, F5: { scanCode: 0x3f },
  F6: { scanCode: 0x40 }, F7: { scanCode: 0x41 }, F8: { scanCode: 0x42 },
  F9: { scanCode: 0x43 }, F10: { scanCode: 0x44 }, NumLock: { scanCode: 0x45 },
  ScrollLock: { scanCode: 0x46 }, Numpad7: { scanCode: 0x47 }, Numpad8: { scanCode: 0x48 },
  Numpad9: { scanCode: 0x49 }, NumpadSubtract: { scanCode: 0x4a }, Numpad4: { scanCode: 0x4b },
  Numpad5: { scanCode: 0x4c }, Numpad6: { scanCode: 0x4d }, NumpadAdd: { scanCode: 0x4e },
  Numpad1: { scanCode: 0x4f }, Numpad2: { scanCode: 0x50 }, Numpad3: { scanCode: 0x51 },
  Numpad0: { scanCode: 0x52 }, NumpadDecimal: { scanCode: 0x53 }, F11: { scanCode: 0x57 },
  F12: { scanCode: 0x58 }, NumpadEnter: { scanCode: 0x1c, extended: true },
  ControlRight: { scanCode: 0x1d, extended: true }, NumpadDivide: { scanCode: 0x35, extended: true },
  PrintScreen: { scanCode: 0x37, extended: true }, AltRight: { scanCode: 0x38, extended: true },
  Home: { scanCode: 0x47, extended: true }, ArrowUp: { scanCode: 0x48, extended: true },
  PageUp: { scanCode: 0x49, extended: true }, ArrowLeft: { scanCode: 0x4b, extended: true },
  ArrowRight: { scanCode: 0x4d, extended: true }, End: { scanCode: 0x4f, extended: true },
  ArrowDown: { scanCode: 0x50, extended: true }, PageDown: { scanCode: 0x51, extended: true },
  Insert: { scanCode: 0x52, extended: true }, Delete: { scanCode: 0x53, extended: true },
  MetaLeft: { scanCode: 0x5b, extended: true }, MetaRight: { scanCode: 0x5c, extended: true },
  ContextMenu: { scanCode: 0x5d, extended: true }
}

function asBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

export function decodeRdpRects(frame: Pick<RdpFrame, 'canvasWidth' | 'canvasHeight' | 'data'>): DirtyRect[] | null {
  const { canvasWidth, canvasHeight } = frame
  if (
    !Number.isInteger(canvasWidth) || !Number.isInteger(canvasHeight) ||
    canvasWidth < RDP_MIN_DISPLAY_EDGE || canvasHeight < RDP_MIN_DISPLAY_EDGE ||
    canvasWidth > RDP_MAX_DISPLAY_EDGE || canvasHeight > RDP_MAX_DISPLAY_EDGE ||
    canvasWidth * canvasHeight > RDP_MAX_DISPLAY_PIXELS
  ) return null

  const bytes = asBytes(frame.data)
  if (bytes.byteLength > MAX_FRAME_BYTES) return null
  // The main process strips the OFSR frame header before transferring the
  // payload. Renderer accepts only the frozen v1 rectangle stream; accepting
  // full-screen buffers or a second embedded frame header would make malformed
  // frames appear valid and allow the two endpoints to drift apart.
  return parseDirtyRects(bytes, canvasWidth, canvasHeight)
}

function parseDirtyRects(bytes: Uint8Array, canvasWidth: number, canvasHeight: number, expectedRectCount?: number): DirtyRect[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const rects: DirtyRect[] = []
  let offset = 0
  while (offset < bytes.byteLength) {
    if (rects.length >= MAX_RECT_COUNT || offset + RECT_HEADER_SIZE > bytes.byteLength) return null
    const x = view.getInt32(offset, true)
    const y = view.getInt32(offset + 4, true)
    const width = view.getUint32(offset + 8, true)
    const height = view.getUint32(offset + 12, true)
    const stride = view.getUint32(offset + 16, true)
    const byteLength = view.getUint32(offset + 20, true)
    offset += RECT_HEADER_SIZE

    if (
      x < 0 || y < 0 || width < 1 || height < 1 ||
      x + width > canvasWidth || y + height > canvasHeight ||
      stride < width * 4 || stride > RDP_MAX_DISPLAY_EDGE * 4 ||
      byteLength !== stride * height || byteLength > bytes.byteLength - offset
    ) return null

    rects.push({ x, y, width, height, stride, data: bytes.subarray(offset, offset + byteLength) })
    offset += byteLength
  }
  if (rects.length === 0 || (expectedRectCount !== undefined && rects.length !== expectedRectCount)) return null
  return rects
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('RDP WebGL shader allocation failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'unknown shader error'
    gl.deleteShader(shader)
    throw new Error(`RDP WebGL shader compilation failed: ${log}`)
  }
  return shader
}

function packRows(rect: DirtyRect): Uint8Array {
  const packed = new Uint8Array(rect.width * rect.height * 4)
  const rowBytes = rect.width * 4
  for (let row = 0; row < rect.height; row++) {
    packed.set(rect.data.subarray(row * rect.stride, row * rect.stride + rowBytes), row * rowBytes)
  }
  return packed
}

function schedulePaint(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback())
  else globalThis.setTimeout(callback, 0)
}

interface GlRenderer {
  gl: WebGL2RenderingContext
  program: WebGLProgram
  texture: WebGLTexture
  buffer: WebGLBuffer
  position: number
  uv: number
}

/** A fixed backing canvas renderer with a WebGL2 BGRA swizzle fast path. */
export class RdpCanvasRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly glRenderer: GlRenderer | null
  private readonly context2d: CanvasRenderingContext2D | null
  private frameQueue: QueuedFrame[] = []
  private scheduled = false
  private disposed = false
  private latestSequence = -1
  private renderedSequence = -1
  private hasDisplayedFrame = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    let glRenderer: GlRenderer | null = null
    try {
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false })
      if (gl) glRenderer = this.createGlRenderer(gl)
    } catch {
      glRenderer = null
    }
    this.glRenderer = glRenderer
    this.context2d = glRenderer ? null : canvas.getContext('2d', { alpha: false })
    if (!this.glRenderer && !this.context2d) throw new Error('RDP canvas has no supported renderer')
    if (this.glRenderer) this.allocateTexture(canvas.width, canvas.height)
  }

  enqueue(frame: RdpFrame, ack?: () => void): void {
    if (this.disposed || !Number.isInteger(frame.sequence) || frame.sequence <= this.latestSequence) {
      ack?.()
      return
    }
    this.latestSequence = frame.sequence
    // Keep at most two frames including the one currently displayed. Once a
    // backing canvas exists, only one newer frame may wait behind it; the
    // render tick consumes that newest frame and makes this latest-wins.
    this.frameQueue.push({ frame, ack })
    const maxPending = this.hasDisplayedFrame ? 1 : 2
    if (this.frameQueue.length > maxPending) {
      const dropped = this.frameQueue.splice(0, this.frameQueue.length - maxPending)
      for (const item of dropped) item.ack?.()
    }
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    const queued = this.frameQueue
    this.frameQueue = []
    for (const item of queued) item.ack?.()
    if (this.glRenderer) {
      const { gl, program, texture } = this.glRenderer
      gl.deleteTexture(texture)
      gl.deleteProgram(program)
      gl.deleteBuffer(this.glRenderer.buffer)
    }
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    schedulePaint(() => {
      this.scheduled = false
      if (this.disposed) return
      const queued = this.frameQueue.pop()
      const skipped = this.frameQueue
      this.frameQueue = []
      for (const item of skipped) item.ack?.()
      if (queued && queued.frame.sequence > this.renderedSequence) {
        const frame = queued.frame
        const rects = decodeRdpRects(frame)
        try {
          if (rects) {
            this.paint(frame.canvasWidth, frame.canvasHeight, rects)
            this.renderedSequence = frame.sequence
            this.hasDisplayedFrame = true
          }
        } finally {
          // ACK after texture upload / putImageData. Invalid frames are
          // consumed as well, preventing a malformed frame from stalling main.
          queued.ack?.()
        }
      } else if (queued) {
        queued.ack?.()
      }
      if (this.frameQueue.length > 0) this.schedule()
    })
  }

  private paint(canvasWidth: number, canvasHeight: number, rects: DirtyRect[]): void {
    if (this.canvas.width !== canvasWidth || this.canvas.height !== canvasHeight) {
      // Assigning width/height resets both the 2D context and GL drawing state;
      // texture storage is recreated below before the first rectangle upload.
      this.canvas.width = canvasWidth
      this.canvas.height = canvasHeight
      if (this.glRenderer) this.allocateTexture(canvasWidth, canvasHeight)
    }
    if (this.glRenderer) {
      this.paintGl(canvasWidth, canvasHeight, rects)
    } else if (this.context2d) {
      this.paint2d(rects)
    }
  }

  private paint2d(rects: DirtyRect[]): void {
    const ctx = this.context2d
    if (!ctx) return
    for (const rect of rects) {
      const rgba = new Uint8ClampedArray(rect.width * rect.height * 4)
      for (let row = 0; row < rect.height; row++) {
        const sourceOffset = row * rect.stride
        const targetOffset = row * rect.width * 4
        for (let col = 0; col < rect.width; col++) {
          const source = sourceOffset + col * 4
          const target = targetOffset + col * 4
          rgba[target] = rect.data[source + 2]
          rgba[target + 1] = rect.data[source + 1]
          rgba[target + 2] = rect.data[source]
          rgba[target + 3] = rect.data[source + 3]
        }
      }
      const image = ctx.createImageData(rect.width, rect.height)
      image.data.set(rgba)
      ctx.putImageData(image, rect.x, rect.y)
    }
  }

  private paintGl(canvasWidth: number, canvasHeight: number, rects: DirtyRect[]): void {
    const state = this.glRenderer
    if (!state) return
    const { gl, texture, program, position, uv } = state
    gl.bindTexture(gl.TEXTURE_2D, texture)
    for (const rect of rects) {
      // The shader swaps sampled BGRA into displayed RGBA, so no per-pixel
      // conversion or temporary full-frame buffer is needed on the fast path.
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      // RDP coordinates are top-left based while WebGL texture coordinates are
      // bottom-left based. Flip each upload and invert its destination row.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      const packed = rect.stride === rect.width * 4 ? rect.data : packRows(rect)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, canvasHeight - rect.y - rect.height, rect.width, rect.height, gl.RGBA, gl.UNSIGNED_BYTE, packed)
    }
    gl.viewport(0, 0, canvasWidth, canvasHeight)
    gl.useProgram(program)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.enableVertexAttribArray(position)
    gl.enableVertexAttribArray(uv)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private createGlRenderer(gl: WebGL2RenderingContext): GlRenderer {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
      in vec2 a_position;
      in vec2 a_uv;
      out vec2 v_uv;
      void main() { gl_Position = vec4(a_position, 0.0, 1.0); v_uv = a_uv; }
    `)
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
      precision mediump float;
      uniform sampler2D u_texture;
      in vec2 v_uv;
      out vec4 outColor;
      void main() { vec4 bgra = texture(u_texture, v_uv); outColor = bgra.bgra; }
    `)
    const program = gl.createProgram()
    if (!program) throw new Error('RDP WebGL program allocation failed')
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'unknown program error'
      gl.deleteProgram(program)
      throw new Error(`RDP WebGL program link failed: ${log}`)
    }
    const position = gl.getAttribLocation(program, 'a_position')
    const uv = gl.getAttribLocation(program, 'a_uv')
    const texture = gl.createTexture()
    if (position < 0 || uv < 0 || !texture) throw new Error('RDP WebGL bindings unavailable')
    const buffer = gl.createBuffer()
    if (!buffer) throw new Error('RDP WebGL buffer allocation failed')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0,
      1, -1, 1, 0,
      -1, 1, 0, 1,
      1, 1, 1, 1
    ]), gl.STATIC_DRAW)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8)
    gl.useProgram(program)
    gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return { gl, program, texture, buffer, position, uv }
  }

  private allocateTexture(width: number, height: number): void {
    const state = this.glRenderer
    if (!state) return
    const { gl, texture } = state
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.clearColor(0.06, 0.07, 0.09, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
}

export function RdpPane({ tab, active }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<RdpCanvasRenderer | null>(null)
  const pendingFramesRef = useRef<QueuedFrame[]>([])
  const pressedKeysRef = useRef(new Map<string, { scanCode: number; extended?: true }>())
  const updateTab = useSessionStore((s) => s.updateTab)
  const reconnectTab = useSessionStore((s) => s.reconnectTab)
  const profileId = tab.profileId
  const canControl = active && tab.state === 'ready' && !!tab.sessionId

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const renderer = new RdpCanvasRenderer(canvas)
      rendererRef.current = renderer
      for (const queued of pendingFramesRef.current) renderer.enqueue(queued.frame, queued.ack)
      pendingFramesRef.current = []
    } catch {
      rendererRef.current = null
    }
    return () => {
      rendererRef.current?.dispose()
      rendererRef.current = null
      const queued = pendingFramesRef.current
      pendingFramesRef.current = []
      for (const item of queued) item.ack?.()
    }
  }, [tab.sessionId, tab.state])

  useEffect(() => {
    if (!tab.sessionId) return
    const sessionId = tab.sessionId
    // The production path uses a dedicated MessagePort so frame buffers can be
    // transferred without cloning. Register it before the legacy event below.
    let portDeliveredFrame = false
    const offPort = ofs.connectRdpPort(sessionId, (message: RdpPortMessage, ack) => {
      if (message.kind !== 'frame') return
      portDeliveredFrame = true
      enqueueFrame({
        sequence: message.sequence,
        canvasWidth: message.canvasWidth,
        canvasHeight: message.canvasHeight,
        data: new Uint8Array(message.buffer)
      }, ack ? () => ack(message.sequence) : undefined)
    })

    // Compatibility path for an older main process or browser mock. Production
    // RdpSessionManager never emits this event, so it is not a second frame
    // transport in the packaged application.
    const offFrame = ofs.on('rdp:frame', (event) => {
      if (event.sessionId !== sessionId || portDeliveredFrame) return
      enqueueFrame(event.frame)
    })

    return () => { offFrame(); offPort() }

    function enqueueFrame(frame: RdpFrame, ack?: () => void): void {
      const renderer = rendererRef.current
      if (renderer) {
        renderer.enqueue(frame, ack)
      } else {
        pendingFramesRef.current.push({ frame, ack })
        if (pendingFramesRef.current.length > 2) {
          const dropped = pendingFramesRef.current.splice(0, pendingFramesRef.current.length - 2)
          for (const item of dropped) item.ack?.()
        }
      }
    }
  // A reconnect deliberately reuses sessionId, while main closes the old
  // MessagePort and waits for the replacement Worker. Rebind on the explicit
  // epoch so the new Worker never falls back to a permanently paused stdout.
  }, [tab.sessionId, tab.rdpPortEpoch])

  useEffect(() => {
    const sessionId = tab.sessionId
    if (!sessionId) return
    return ofs.on('rdp:clipboard', (event) => {
      if (event.sessionId !== sessionId || !navigator.clipboard) return
      void navigator.clipboard.writeText(event.text).catch(() => {})
    })
  }, [tab.sessionId])

  useEffect(() => {
    if (!active || tab.state !== 'ready' || !tab.sessionId) releasePressedKeys()
  }, [active, tab.sessionId, tab.state])

  useEffect(() => {
    const host = hostRef.current
    const sessionId = tab.sessionId
    if (!host || !sessionId || tab.state !== 'ready' || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const resize = (): void => {
      const rect = host.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      const display = clampRdpDisplaySize({
        width: rect.width,
        height: rect.height,
        dpi: (window.devicePixelRatio || 1) * 96
      })
      void ofs.invoke('rdp:resize', { sessionId, display }).catch(() => {})
    }
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(resize, 100)
    })
    observer.observe(host)
    resize()
    return () => { observer.disconnect(); if (timer) clearTimeout(timer) }
  }, [tab.sessionId, tab.state])

  const retry = (): void => {
    updateTab(tab.id, { state: 'connecting', error: undefined })
    void reconnectTab(tab.id)
  }

  const sendRdpInput = (input: RdpInput): void => {
    if (!canControl || !tab.sessionId) return
    void ofs.invoke('rdp:input', { sessionId: tab.sessionId, input }).catch(() => {})
  }

  const releasePressedKeys = (): void => {
    const sessionId = tab.sessionId
    if (!sessionId || pressedKeysRef.current.size === 0) {
      pressedKeysRef.current.clear()
      return
    }
    const pressed = [...pressedKeysRef.current.values()]
    pressedKeysRef.current.clear()
    for (const key of pressed) {
      void ofs.invoke('rdp:input', {
        sessionId,
        input: { kind: 'key', scanCode: key.scanCode, pressed: false, ...(key.extended ? { extended: true } : {}) }
      }).catch(() => {})
    }
  }

  const launchSystemFallback = (): void => {
    const action = tab.sessionId
      ? ofs.invoke('rdp:systemFallback', tab.sessionId)
      : ofs.invoke('conn:launchRdp', profileId)
    void action
      .then(() => message.success(t('conn.rdpSystemFallbackLaunched')))
      .catch((err) => message.error(err instanceof Error ? err.message : String(err)))
  }

  const sendKey = (event: React.KeyboardEvent<HTMLCanvasElement>, pressed: boolean): void => {
    if (!canControl || !tab.sessionId) return
    const scan = RDP_SCANCODES[event.code]
    // Layout-independent DOM codes map to the RDP Set-1 physical key space.
    // Unknown browser/media keys are intentionally not forwarded.
    if (!scan) return
    event.preventDefault()
    if (pressed) pressedKeysRef.current.set(event.code, scan)
    else pressedKeysRef.current.delete(event.code)
    const unicode = pressed && event.key.length === 1 ? event.key.codePointAt(0) : undefined
    sendRdpInput({ kind: 'key', scanCode: scan.scanCode, pressed, ...(scan.extended ? { extended: true } : {}), ...(unicode !== undefined ? { unicode } : {}) })
  }

  const sendPointer = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!canControl) return
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!canvas || !rect || rect.width < 1 || rect.height < 1) return
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / rect.width)))
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / rect.height)))
    sendRdpInput({ kind: 'pointer', x, y, buttons: event.buttons })
  }

  const sendWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    if (!canControl) return
    event.preventDefault()
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!canvas || !rect || rect.width < 1 || rect.height < 1) return
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / rect.width)))
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / rect.height)))
    sendRdpInput({ kind: 'pointer', x, y, buttons: 0, wheelX: Math.round(event.deltaX), wheelY: Math.round(event.deltaY) })
  }

  const sendPaste = (event: React.ClipboardEvent<HTMLCanvasElement>): void => {
    if (!canControl || !tab.sessionId) return
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    void ofs.invoke('rdp:clipboardSet', { sessionId: tab.sessionId, text }).catch(() => {})
  }

  const requestClipboard = (event: React.ClipboardEvent<HTMLCanvasElement>): void => {
    if (!canControl || !tab.sessionId) return
    event.preventDefault()
    void ofs.invoke('rdp:clipboardGet', tab.sessionId).catch(() => {})
  }

  if (tab.state === 'closed') return <div className={styles.empty}><Empty description={tab.error || t('terminal.disconnected')}><Space><Button icon={<RotateCcw size={14} />} onClick={retry}>{t('common.retry')}</Button><Button icon={<MonitorUp size={14} />} onClick={launchSystemFallback}>{t('conn.rdpSystemFallback')}</Button></Space></Empty></div>
  if (!tab.sessionId || tab.state === 'connecting') return <div className={styles.empty}><Spin size="small" /> <span>{t('terminal.connecting', { target: 'RDP' })}</span></div>
  return <div ref={hostRef} className={styles.host} data-active={active}>
    <canvas ref={canvasRef} className={styles.canvas} tabIndex={0} onKeyDown={(e) => sendKey(e, true)} onKeyUp={(e) => sendKey(e, false)} onBlur={releasePressedKeys} onMouseMove={sendPointer} onMouseDown={(e) => { e.currentTarget.focus(); sendPointer(e) }} onMouseUp={sendPointer} onWheel={sendWheel} onPaste={sendPaste} onCopy={requestClipboard} />
    <span className={styles.srOnly}>{profileId}</span>
  </div>
}
