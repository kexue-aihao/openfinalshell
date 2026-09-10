import { useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Empty, Progress, Space, Spin } from 'antd'
import { MonitorUp, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ofs } from '@/ipc/api'
import { useSessionStore, type SessionTab } from '@/stores/useSessionStore'
import { formatBytes, formatSpeed } from '@/utils/format'
import {
  RDP_MAX_DISPLAY_EDGE,
  RDP_MAX_DISPLAY_PIXELS,
  RDP_MIN_DISPLAY_EDGE,
  clampRdpDisplaySize,
  type RdpClipboardProgress,
  type RdpClipboardRemoteFile,
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
const CLIPBOARD_SETTLE_MS = 75

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

function packRowsForTexture(rect: DirtyRect): Uint8Array {
  const packed = new Uint8Array(rect.width * rect.height * 4)
  const rowBytes = rect.width * 4
  // RDP rows are top-to-bottom while WebGL texture rows are addressed from
  // the bottom. Reverse rows explicitly instead of relying on
  // UNPACK_FLIP_Y_WEBGL, whose behavior differs for typed-array uploads.
  for (let targetRow = 0; targetRow < rect.height; targetRow++) {
    const sourceRow = rect.height - targetRow - 1
    packed.set(rect.data.subarray(sourceRow * rect.stride, sourceRow * rect.stride + rowBytes), targetRow * rowBytes)
  }
  return packed
}

function schedulePaint(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback())
  else globalThis.setTimeout(callback, 0)
}

interface GlRenderer {
  gl: WebGL2RenderingContext
  canvas: HTMLCanvasElement
  program: WebGLProgram
  texture: WebGLTexture
  buffer: WebGLBuffer
  position: number
  uv: number
}

interface RdpCanvasRendererOptions {
  /** Keep the stable Canvas2D path as the production default. */
  useWebgl?: boolean
}

/** A fixed backing canvas renderer with an opt-in WebGL2 upload path. */
export class RdpCanvasRenderer {
  private readonly canvas: HTMLCanvasElement
  private glRenderer: GlRenderer | null
  private readonly context2d: CanvasRenderingContext2D | null
  private frameQueue: QueuedFrame[] = []
  private scheduled = false
  private disposed = false
  private latestSequence = -1
  private renderedSequence = -1
  private scratchImageData: ImageData | null = null

  constructor(canvas: HTMLCanvasElement, options: RdpCanvasRendererOptions = {}) {
    this.canvas = canvas
    // Keep the visible canvas in 2D mode. A canvas cannot switch from a
    // failed WebGL context to 2D, so WebGL is deliberately isolated on an
    // offscreen canvas and can be abandoned at any point.
    this.context2d = canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!this.context2d) throw new Error('RDP canvas has no supported 2D renderer')

    let glRenderer: GlRenderer | null = null
    if (options.useWebgl === true) {
      try {
        const glCanvas = document.createElement('canvas')
        const gl = glCanvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false })
        if (gl) glRenderer = this.createGlRenderer(gl, glCanvas)
      } catch {
        glRenderer = null
      }
    }
    this.glRenderer = glRenderer
    if (glRenderer) {
      try {
        glRenderer.canvas.width = canvas.width
        glRenderer.canvas.height = canvas.height
        this.allocateTexture(canvas.width, canvas.height)
      } catch {
        this.releaseGlRenderer()
      }
    }
  }

  enqueue(frame: RdpFrame, ack?: () => void): void {
    if (this.disposed || !Number.isInteger(frame.sequence) || frame.sequence <= this.latestSequence) {
      ack?.()
      return
    }
    this.latestSequence = frame.sequence
    // FRAME payloads are dirty-rectangle deltas, not complete snapshots. Keep
    // every queued delta in sequence; dropping one can leave stale or black
    // regions even when a newer frame is successfully rendered.
    this.frameQueue.push({ frame, ack })
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    const queued = this.frameQueue
    this.frameQueue = []
    for (const item of queued) item.ack?.()
    this.scratchImageData = null
    this.releaseGlRenderer()
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    schedulePaint(() => {
      this.scheduled = false
      if (this.disposed) return
      const queued = this.frameQueue
      this.frameQueue = []
      let batchWidth = 0
      let batchHeight = 0
      let batchRects: DirtyRect[] = []
      let batchItems: QueuedFrame[] = []
      const failedItems: QueuedFrame[] = []
      let paintFailed = false
      const flushBatch = (): void => {
        if (batchItems.length === 0) return
        try {
          this.paint(batchWidth, batchHeight, batchRects)
          this.renderedSequence = batchItems[batchItems.length - 1].frame.sequence
          for (const item of batchItems) item.ack?.()
        } catch {
          // A dirty frame is not safe to acknowledge until its pixels are on
          // the visible canvas. Requeue the whole batch so the main process can
          // retry it after the renderer recovers.
          paintFailed = true
          failedItems.push(...batchItems)
        }
        batchRects = []
        batchItems = []
      }
      for (const item of queued) {
        if (paintFailed) {
          failedItems.push(item)
          continue
        }
        if (item.frame.sequence <= this.renderedSequence) {
          item.ack?.()
          continue
        }
        const rects = decodeRdpRects(item.frame)
        if (!rects) {
          item.ack?.()
          continue
        }
        if (batchRects.length > 0 && (batchWidth !== item.frame.canvasWidth || batchHeight !== item.frame.canvasHeight)) {
          flushBatch()
        }
        batchWidth = item.frame.canvasWidth
        batchHeight = item.frame.canvasHeight
        batchRects.push(...rects)
        batchItems.push(item)
      }
      flushBatch()
      if (failedItems.length > 0) {
        this.frameQueue = [...failedItems, ...this.frameQueue]
        this.latestSequence = this.renderedSequence
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
      this.scratchImageData = null
      if (this.glRenderer) {
        const glCanvas = this.glRenderer.canvas
        glCanvas.width = canvasWidth
        glCanvas.height = canvasHeight
        try {
          this.allocateTexture(canvasWidth, canvasHeight)
        } catch {
          this.releaseGlRenderer()
        }
      }
    }
    if (this.glRenderer) {
      try {
        this.paintGl(canvasWidth, canvasHeight, rects)
        return
      } catch {
        // GPU contexts can compile successfully and still fail on the first
        // upload (driver policy, context loss, or an unsupported format).
        // Keep the current frame visible through the already-live 2D path.
        this.releaseGlRenderer()
      }
    }
    this.paint2d(rects)
  }

  private paint2d(rects: DirtyRect[]): void {
    const ctx = this.context2d
    if (!ctx) return
    const largestRect = rects.reduce<DirtyRect | null>((largest, rect) => {
      if (!largest || rect.width * rect.height > largest.width * largest.height) return rect
      return largest
    }, null)
    if (!largestRect) return
    if (!this.scratchImageData || this.scratchImageData.width < largestRect.width || this.scratchImageData.height < largestRect.height) {
      this.scratchImageData = ctx.createImageData(largestRect.width, largestRect.height)
    }
    const image = this.scratchImageData
    for (const rect of rects) {
      const rowBytes = rect.width * 4
      if (rect.stride === rowBytes && image.width === rect.width) {
        // The native Worker publishes canonical RGBA rows. A bulk typed-array
        // copy avoids a JavaScript loop over every pixel on the UI thread.
        image.data.set(new Uint8ClampedArray(rect.data.buffer, rect.data.byteOffset, rowBytes * rect.height), 0)
      } else {
        for (let row = 0; row < rect.height; row++) {
          const sourceOffset = row * rect.stride
          image.data.set(rect.data.subarray(sourceOffset, sourceOffset + rowBytes), row * image.width * 4)
        }
      }
      // Reuse one ImageData allocation and restrict the upload to the current
      // dirty rectangle. This removes per-rectangle GC pressure without
      // copying stale scratch pixels outside the requested dirty area.
      ctx.putImageData(image, rect.x, rect.y, 0, 0, rect.width, rect.height)
    }
  }

  private paintGl(canvasWidth: number, canvasHeight: number, rects: DirtyRect[]): void {
    const state = this.glRenderer
    if (!state) return
    const { gl, texture, program, position, uv } = state
    if (gl.isContextLost()) throw new Error('RDP WebGL context lost')
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    for (const rect of rects) {
      // The Worker publishes canonical RGBA bytes, so no per-pixel color
      // conversion is needed on the upload path.
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      // RDP coordinates are top-left based while WebGL texture coordinates are
      // bottom-left based. Destination Y and the packed row order are both
      // converted explicitly in packRowsForTexture().
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      const packed = packRowsForTexture(rect)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, canvasHeight - rect.y - rect.height, rect.width, rect.height, gl.RGBA, gl.UNSIGNED_BYTE, packed)
    }
    gl.viewport(0, 0, canvasWidth, canvasHeight)
    gl.useProgram(program)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.enableVertexAttribArray(position)
    gl.enableVertexAttribArray(uv)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    const error = gl.getError()
    if (error !== gl.NO_ERROR) throw new Error(`RDP WebGL draw failed: 0x${error.toString(16)}`)
    const context2d = this.context2d
    if (!context2d) throw new Error('RDP 2D presentation context unavailable')
    context2d.drawImage(state.canvas, 0, 0, canvasWidth, canvasHeight)
  }

  private createGlRenderer(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): GlRenderer {
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
      void main() { outColor = texture(u_texture, v_uv); }
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
    return { gl, canvas, program, texture, buffer, position, uv }
  }

  private allocateTexture(width: number, height: number): void {
    const state = this.glRenderer
    if (!state) return
    const { gl, texture, program, buffer, position, uv } = state
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8)
    gl.enableVertexAttribArray(position)
    gl.enableVertexAttribArray(uv)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const error = gl.getError()
    if (error !== gl.NO_ERROR) throw new Error(`RDP WebGL texture allocation failed: 0x${error.toString(16)}`)
  }

  private releaseGlRenderer(): void {
    const state = this.glRenderer
    if (!state) return
    this.glRenderer = null
    state.gl.deleteTexture(state.texture)
    state.gl.deleteProgram(state.program)
    state.gl.deleteBuffer(state.buffer)
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
  const pressedButtonsRef = useRef(0)
  const lastPointerRef = useRef({ x: 0, y: 0 })
  const pendingPointerMoveRef = useRef<RdpInput | null>(null)
  const pointerMoveFrameRef = useRef<number | null>(null)
  const clipboardShortcutRef = useRef<'KeyC' | 'KeyV' | null>(null)
  const [clipboardProgress, setClipboardProgress] = useState<RdpClipboardProgress | null>(null)
  const [remoteFiles, setRemoteFiles] = useState<RdpClipboardRemoteFile[] | null>(null)
  const [downloading, setDownloading] = useState(false)
  const updateTab = useSessionStore((s) => s.updateTab)
  const reconnectTab = useSessionStore((s) => s.reconnectTab)
  const profileId = tab.profileId
  const canControl = active && tab.state === 'ready' && !!tab.sessionId

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      // The experimental WebGL path uploads to an offscreen canvas and then
      // copies the full frame back to the visible 2D canvas. Keep the stable
      // dirty-rectangle Canvas2D path as the production default until a direct
      // visible WebGL renderer is available.
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
    // The production path uses a dedicated MessagePort so frame buffers do not
    // travel through the generic event bus. Electron 43 structured-clones the
    // ArrayBuffer at this boundary; the main process keeps its own frame copy.
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
    const sessionId = tab.sessionId
    if (!sessionId) {
      setClipboardProgress(null)
      return
    }
    return ofs.on('rdp:clipboardProgress', (event) => {
      if (event.sessionId !== sessionId) return
      setClipboardProgress(event)
      if (event.state === 'completed' || event.state === 'failed' || event.state === 'canceled') {
        window.setTimeout(() => setClipboardProgress((current) =>
          current?.sessionId === sessionId && current.state === event.state ? null : current), 4_000)
      }
    })
  }, [tab.sessionId])

  useEffect(() => {
    if (!active || tab.state !== 'ready' || !tab.sessionId) {
      releasePressedKeys()
      releasePressedButtons()
      clipboardShortcutRef.current = null
    }
  }, [active, tab.sessionId, tab.state])

  // Automatic clipboard mirroring runs only while this RDP tab is the active
  // tab AND the window has focus. A background session must never overwrite
  // the user's local clipboard with remote content.
  useEffect(() => {
    const sessionId = tab.sessionId
    if (!sessionId || !active || tab.state !== 'ready') return
    const report = (): void => {
      const enabled = document.hasFocus()
      ofs.invoke('rdp:clipboardSync', { sessionId, enabled }).catch(() => {})
    }
    report()
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    return () => {
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
      // Leaving focus or unmounting must disable mirroring so the worker never
      // writes remote clipboard content into a background/local context.
      ofs.invoke('rdp:clipboardSync', { sessionId, enabled: false }).catch(() => {})
    }
  }, [active, tab.sessionId, tab.state])

  useEffect(() => {
    const host = hostRef.current
    const sessionId = tab.sessionId
    if (!host || !sessionId || !active || tab.state !== 'ready' || typeof ResizeObserver === 'undefined') return
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
  }, [active, tab.sessionId, tab.state])

  useEffect(() => {
    const sessionId = tab.sessionId
    if (!sessionId) return
    const off = ofs.on('rdp:clipboardRemoteFiles', (event) => {
      if (event.sessionId !== sessionId) return
      setRemoteFiles(event.files.length > 0 ? event.files : null)
      setDownloading(false)
    })
    return off
  }, [tab.sessionId])

  useEffect(() => {
    const sessionId = tab.sessionId
    if (!sessionId) return
    const off = ofs.on('rdp:clipboardDownloadResult', (event) => {
      if (event.sessionId !== sessionId) return
      setDownloading(false)
      if (event.state === 'completed') {
        void message.success(t('conn.clipboardDownloadComplete', { count: event.fileCount }))
      } else {
        void message.error(event.error ? t('conn.clipboardDownloadFailedWith', { error: event.error }) : t('conn.clipboardDownloadFailed'))
      }
      setRemoteFiles(null)
    })
    return off
  }, [tab.sessionId])

  const downloadRemoteFiles = async (): Promise<void> => {
    const sessionId = tab.sessionId
    if (!sessionId || !remoteFiles || downloading) return
    try {
      const directory = await ofs.invoke('app:pickPath', { mode: 'openDirectory', title: t('conn.clipboardPickFolder') })
      if (!directory) return
      setDownloading(true)
      await ofs.invoke('rdp:clipboardRemoteFilesDownload', { sessionId, directory })
    } catch (error) {
      setDownloading(false)
      void message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const retry = (): void => {
    updateTab(tab.id, { state: 'connecting', error: undefined })
    void reconnectTab(tab.id)
  }

  const sendRdpInput = (input: RdpInput): void => {
    if (!canControl || !tab.sessionId) return
    postRdpInput(tab.sessionId, input)
  }

  const postRdpInput = (sessionId: string, input: RdpInput): boolean => {
    try {
      ofs.send('rdp:input', { sessionId, input })
      return true
    } catch {
      return false
    }
  }

  const sendRemoteClipboardShortcut = async (sessionId: string, code: 'KeyC' | 'KeyV', modifierAlreadyDown = false): Promise<boolean> => {
    const modifier = RDP_SCANCODES.ControlLeft
    const key = RDP_SCANCODES[code]
    if (!modifier || !key) return false
    let modifierDown = modifierAlreadyDown
    let ownsModifier = false
    let keyDown = false
    try {
      if (!modifierAlreadyDown) {
        if (!postRdpInput(sessionId, { kind: 'key', scanCode: modifier.scanCode, pressed: true })) return false
        modifierDown = true
        ownsModifier = true
      }
      if (!postRdpInput(sessionId, { kind: 'key', scanCode: key.scanCode, pressed: true })) return false
      keyDown = true
      if (!postRdpInput(sessionId, { kind: 'key', scanCode: key.scanCode, pressed: false })) return false
      keyDown = false
      if (ownsModifier) {
        if (!postRdpInput(sessionId, { kind: 'key', scanCode: modifier.scanCode, pressed: false })) return false
        modifierDown = false
      }
      return true
    } finally {
      if (keyDown) postRdpInput(sessionId, { kind: 'key', scanCode: key.scanCode, pressed: false })
      if (ownsModifier && modifierDown) postRdpInput(sessionId, { kind: 'key', scanCode: modifier.scanCode, pressed: false })
    }
  }

  const sendClipboardShortcut = (code: 'KeyC' | 'KeyV', modifierAlreadyDown = false): void => {
    const sessionId = tab.sessionId
    if (!canControl || !sessionId) return
    void (async () => {
      if (code === 'KeyV') {
        // Read CF_HDROP through Windows; registered-format aliases can lose multiple files.
        const nativeFiles = await ofs.invoke('rdp:clipboardLocalFiles', sessionId)
        const files = Array.isArray(nativeFiles) ? nativeFiles :
          typeof ofs.getClipboardFilePaths === 'function' ? ofs.getClipboardFilePaths() : []
        if (files.length > 0) {
          await ofs.invoke('rdp:clipboardFilesSet', { sessionId, files })
          const modifierIsStillDown = modifierAlreadyDown &&
            (pressedKeysRef.current.has('ControlLeft') || pressedKeysRef.current.has('ControlRight'))
          await sendRemoteClipboardShortcut(sessionId, code, modifierIsStillDown)
          return
        }
        const text = await navigator.clipboard?.readText().catch(() => '')
        // Remote virtual files have no CF_HDROP paths or text. The server
        // already owns that selection; still deliver Ctrl+V to Explorer.
        if (text) await ofs.invoke('rdp:clipboardSet', { sessionId, text })
        const modifierIsStillDown = modifierAlreadyDown &&
          (pressedKeysRef.current.has('ControlLeft') || pressedKeysRef.current.has('ControlRight'))
        await sendRemoteClipboardShortcut(sessionId, code, modifierIsStillDown)
        return
      }
      if (!await sendRemoteClipboardShortcut(sessionId, code, modifierAlreadyDown)) return
      // Allow the remote shell to publish the new selection before asking
      // cliprdr for its data; otherwise the request can race Ctrl+C.
      await new Promise<void>((resolve) => window.setTimeout(resolve, CLIPBOARD_SETTLE_MS))
      await ofs.invoke('rdp:clipboardGet', sessionId)
    })().catch((error: unknown) => {
      // A copy is a pull from the remote desktop; do not mislabel it as an
      // upload failure. Silent loss here also overwrites the user's mental
      // model of what ended up in the local clipboard.
      if (code === 'KeyC') {
        const label = t('conn.rdpClipboardCopyFailed')
        setClipboardProgress({ sessionId, state: 'failed', fileIndex: 0, fileCount: 0,
          transferred: 0, total: 0, speedBps: 0, error: label })
        if ((error instanceof Error ? error.message : String(error)) !== 'SESSION_NOT_READY') {
          void message.error(label)
        }
        return
      }
      const label = t('conn.clipboardUploadFailed')
      setClipboardProgress({ sessionId, state: 'failed', fileIndex: 0, fileCount: 0,
        transferred: 0, total: 0, speedBps: 0, error: label })
    })
  }

  const flushPointerMove = (): void => {
    pointerMoveFrameRef.current = null
    const pending = pendingPointerMoveRef.current
    pendingPointerMoveRef.current = null
    if (pending) sendRdpInput(pending)
  }

  const queuePointerMove = (input: RdpInput): void => {
    pendingPointerMoveRef.current = input
    if (pointerMoveFrameRef.current !== null) return
    if (typeof window.requestAnimationFrame === 'function') {
      pointerMoveFrameRef.current = window.requestAnimationFrame(() => flushPointerMove())
    } else {
      pointerMoveFrameRef.current = window.setTimeout(() => flushPointerMove(), 0)
    }
  }

  const flushQueuedPointerMove = (): void => {
    if (pointerMoveFrameRef.current !== null) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(pointerMoveFrameRef.current)
      else window.clearTimeout(pointerMoveFrameRef.current)
      pointerMoveFrameRef.current = null
    }
    const pending = pendingPointerMoveRef.current
    pendingPointerMoveRef.current = null
    if (pending) sendRdpInput(pending)
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
      postRdpInput(sessionId, {
        kind: 'key', scanCode: key.scanCode, pressed: false, ...(key.extended ? { extended: true } : {})
      })
    }
  }

  const releasePressedButtons = (): void => {
    flushQueuedPointerMove()
    const sessionId = tab.sessionId
    const buttons = pressedButtonsRef.current
    pressedButtonsRef.current = 0
    if (!sessionId || buttons === 0) return
    postRdpInput(sessionId, {
      kind: 'pointer', x: lastPointerRef.current.x, y: lastPointerRef.current.y, buttons: 0
    })
  }

  useEffect(() => {
    const release = (): void => {
      releasePressedKeys()
      releasePressedButtons()
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') release()
    }
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      release()
      clipboardShortcutRef.current = null
      pendingPointerMoveRef.current = null
      if (pointerMoveFrameRef.current !== null) {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(pointerMoveFrameRef.current)
        else window.clearTimeout(pointerMoveFrameRef.current)
        pointerMoveFrameRef.current = null
      }
    }
  }, [tab.sessionId])

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
    const unicode = pressed && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey
      ? event.key.codePointAt(0)
      : undefined
    sendRdpInput({ kind: 'key', scanCode: scan.scanCode, pressed, ...(scan.extended ? { extended: true } : {}), ...(unicode !== undefined ? { unicode } : {}) })
  }

  const pointerButtonMask = (button: number): number => {
    if (button === 0) return 1 // left
    if (button === 2) return 2 // right
    if (button === 1) return 4 // middle
    return 0
  }

  const pointerPosition = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!canvas || !rect || rect.width < 1 || rect.height < 1 || canvas.width < 1 || canvas.height < 1) return null
    const canvasRatio = canvas.width / canvas.height
    const boxRatio = rect.width / rect.height
    const renderedWidth = boxRatio > canvasRatio ? rect.height * canvasRatio : rect.width
    const renderedHeight = boxRatio > canvasRatio ? rect.height : rect.width / canvasRatio
    const offsetX = (rect.width - renderedWidth) / 2
    const offsetY = (rect.height - renderedHeight) / 2
    const localX = clientX - rect.left - offsetX
    const localY = clientY - rect.top - offsetY
    if (localX < 0 || localY < 0 || localX >= renderedWidth || localY >= renderedHeight) return null
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round(localX * canvas.width / renderedWidth)))
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round(localY * canvas.height / renderedHeight)))
    lastPointerRef.current = { x, y }
    return { x, y }
  }

  const sendPointer = (event: React.PointerEvent<HTMLCanvasElement>, immediate = false, allowOutside = false): void => {
    if (!canControl) return
    const point = pointerPosition(event.clientX, event.clientY) ??
      ((allowOutside || pressedButtonsRef.current !== 0) ? lastPointerRef.current : null)
    if (!point) return
    const input: RdpInput = { kind: 'pointer', ...point, buttons: pressedButtonsRef.current }
    if (immediate) {
      flushQueuedPointerMove()
      sendRdpInput(input)
    } else {
      queuePointerMove(input)
    }
  }

  const sendWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    if (!canControl) return
    event.preventDefault()
    const point = pointerPosition(event.clientX, event.clientY)
    if (!point) return
    const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 120 : 1
    const clampWheel = (value: number): number => Math.max(-127, Math.min(127, Math.round(value * scale)))
    flushQueuedPointerMove()
    sendRdpInput({
      kind: 'pointer',
      ...point,
      buttons: pressedButtonsRef.current,
      wheelX: clampWheel(event.deltaX),
      wheelY: clampWheel(event.deltaY)
    })
  }

  const sendPaste = (event: React.ClipboardEvent<HTMLCanvasElement>): void => {
    if (!canControl || !tab.sessionId) return
    const files = Array.from(event.clipboardData.files ?? [])
      .map((file) => ofs.getPathForFile(file))
      .filter((path) => path.length > 0)
    if (files.length > 0) {
      event.preventDefault()
      const sessionId = tab.sessionId
      const modifierAlreadyDown = pressedKeysRef.current.has('ControlLeft') || pressedKeysRef.current.has('ControlRight')
      void ofs.invoke('rdp:clipboardFilesSet', { sessionId, files })
        .then(() => sendRemoteClipboardShortcut(sessionId, 'KeyV', modifierAlreadyDown &&
          (pressedKeysRef.current.has('ControlLeft') || pressedKeysRef.current.has('ControlRight'))))
        .catch((error: unknown) => {
          setClipboardProgress({
            sessionId,
            state: 'failed',
            fileIndex: 0,
            fileCount: files.length,
            transferred: 0,
            total: 0,
            speedBps: 0,
            error: error instanceof Error ? error.message : t('conn.clipboardUploadFailed')
          })
        })
      return
    }
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    const sessionId = tab.sessionId
    const modifierAlreadyDown = pressedKeysRef.current.has('ControlLeft') || pressedKeysRef.current.has('ControlRight')
    void ofs.invoke('rdp:clipboardSet', { sessionId, text })
      .then(() => sendRemoteClipboardShortcut(sessionId, 'KeyV', modifierAlreadyDown &&
        (pressedKeysRef.current.has('ControlLeft') || pressedKeysRef.current.has('ControlRight'))))
      .catch(() => {})
  }

  const uploadDroppedFiles = (event: React.DragEvent<HTMLCanvasElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!canControl || !tab.sessionId) return
    const files = Array.from(event.dataTransfer.files ?? [])
      .map((file) => ofs.getPathForFile(file))
      .filter((path) => path.length > 0)
    if (files.length === 0) return
    const sessionId = tab.sessionId
    void ofs.invoke('rdp:clipboardFilesSet', { sessionId, files })
      .then(() => sendRemoteClipboardShortcut(sessionId, 'KeyV'))
      .catch((error: unknown) => {
        setClipboardProgress({
          sessionId,
          state: 'failed',
          fileIndex: 0,
          fileCount: files.length,
          transferred: 0,
          total: 0,
          speedBps: 0,
          error: error instanceof Error ? error.message : t('conn.clipboardUploadFailed')
        })
      })
  }

  const requestClipboard = (event: React.ClipboardEvent<HTMLCanvasElement>): void => {
    if (!canControl || !tab.sessionId) return
    event.preventDefault()
    void ofs.invoke('rdp:clipboardGet', tab.sessionId).catch(() => {})
  }

  if (tab.state === 'closed') return <div className={styles.empty}><Empty description={tab.error || t('terminal.disconnected')}><Space><Button icon={<RotateCcw size={14} />} onClick={retry}>{t('common.retry')}</Button><Button icon={<MonitorUp size={14} />} onClick={launchSystemFallback}>{t('conn.rdpSystemFallback')}</Button></Space></Empty></div>
  if (!tab.sessionId || tab.state === 'connecting') return <div className={styles.empty}><Spin size="small" /> <span>{t('terminal.connecting', { target: 'RDP' })}</span></div>
  return <div ref={hostRef} className={styles.host} data-active={active}>
     <canvas
       ref={canvasRef}
       className={styles.canvas}
       tabIndex={0}
       onKeyDown={(e) => {
         if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.repeat && (e.code === 'KeyC' || e.code === 'KeyV')) {
           e.preventDefault()
           if (clipboardShortcutRef.current) return
           clipboardShortcutRef.current = e.code
           const modifierAlreadyDown = pressedKeysRef.current.has('ControlLeft') || pressedKeysRef.current.has('ControlRight')
           sendClipboardShortcut(e.code, modifierAlreadyDown)
           return
         }
         if (clipboardShortcutRef.current) return
         sendKey(e, true)
       }}
       onKeyUp={(e) => {
         const shortcut = clipboardShortcutRef.current
         if (shortcut && e.code === shortcut) {
           e.preventDefault()
           if (!pressedKeysRef.current.has('ControlLeft') && !pressedKeysRef.current.has('ControlRight') &&
               !pressedKeysRef.current.has('MetaLeft') && !pressedKeysRef.current.has('MetaRight')) {
             clipboardShortcutRef.current = null
           }
           return
         }
         if (shortcut && ['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'].includes(e.code)) {
           clipboardShortcutRef.current = null
         }
         sendKey(e, false)
       }}
       onBlur={() => { releasePressedKeys(); releasePressedButtons() }}
       onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
       onDrop={uploadDroppedFiles}
       onPointerMove={(e) => sendPointer(e)}
       onPointerDown={(e) => {
         e.preventDefault()
         e.currentTarget.focus()
         const mask = pointerButtonMask(e.button)
         if (mask === 0 || !pointerPosition(e.clientX, e.clientY)) return
         pressedButtonsRef.current |= mask
         try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* capture may be unavailable in test DOM */ }
         sendPointer(e, true)
       }}
       onPointerUp={(e) => {
         e.preventDefault()
         pressedButtonsRef.current &= ~pointerButtonMask(e.button)
         sendPointer(e, true, true)
         try {
           if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
         } catch { /* capture may be unavailable in test DOM */ }
       }}
       onPointerCancel={() => releasePressedButtons()}
       onLostPointerCapture={() => { if (pressedButtonsRef.current !== 0) releasePressedButtons() }}
       onWheel={sendWheel}
       onContextMenu={(e) => e.preventDefault()}
       onPaste={sendPaste}
       onCopy={requestClipboard}
      />
      {clipboardProgress && (
        <div className={styles.clipboardProgress} role="status">
          <div className={styles.clipboardProgressTitle}>
            <span>{clipboardProgress.state === 'completed' ? t('conn.clipboardUploadComplete') :
              clipboardProgress.state === 'failed' ? t('conn.clipboardUploadFailed') :
              t('conn.clipboardUploading')}</span>
            {clipboardProgress.fileName && <span className={styles.clipboardFileName}>{clipboardProgress.fileName}</span>}
          </div>
          <Progress
            percent={clipboardProgress.total > 0
              ? Math.min(100, Math.round(clipboardProgress.transferred * 100 / clipboardProgress.total))
              : clipboardProgress.state === 'completed' ? 100 : 0}
            status={clipboardProgress.state === 'failed' ? 'exception' : clipboardProgress.state === 'completed' ? 'success' : 'active'}
            showInfo={false}
            size="small"
          />
          <div className={styles.clipboardProgressMeta}>
            <span>{clipboardProgress.total > 0
              ? `${formatBytes(clipboardProgress.transferred)} / ${formatBytes(clipboardProgress.total)}`
              : `${clipboardProgress.fileIndex} / ${clipboardProgress.fileCount}`}</span>
            <span>{clipboardProgress.speedBps > 0 ? formatSpeed(clipboardProgress.speedBps) : ''}</span>
          </div>
          {clipboardProgress.error && <div className={styles.clipboardProgressError}>{clipboardProgress.error}</div>}
        </div>
      )}
      {remoteFiles && !clipboardProgress && (
        <div className={`${styles.clipboardProgress} ${styles.remoteFilesCard}`} role="status">
          <div className={styles.clipboardProgressTitle}>
            <span>{downloading ? t('conn.clipboardDownloading') : t('conn.clipboardRemoteFilesReady', { count: remoteFiles.length })}</span>
          </div>
          <div className={styles.remoteFilesSummary}>
            {remoteFiles.slice(0, 3).map((f) => (
              <div key={f.name} className={styles.clipboardFileName}>
                {f.directory ? '📁 ' : ''}{f.name}{!f.directory ? ` · ${formatBytes(f.size)}` : ''}
              </div>
            ))}
            {remoteFiles.length > 3 && <div className={styles.clipboardFileName}>+{remoteFiles.length - 3}</div>}
          </div>
          <div className={styles.remoteFilesActions}>
            <Button size="small" loading={downloading} onClick={() => void downloadRemoteFiles()}>
              {t('conn.clipboardDownloadToFolder')}
            </Button>
            <Button size="small" onClick={() => setRemoteFiles(null)}>{t('common.close')}</Button>
          </div>
        </div>
      )}
      <span className={styles.srOnly}>{profileId}</span>
  </div>
}
