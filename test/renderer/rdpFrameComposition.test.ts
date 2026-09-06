// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/ipc/api', () => ({
  ofs: {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(() => () => {}),
    connectRdpPort: vi.fn(() => () => {})
  }
}))

import { RdpCanvasRenderer, decodeRdpRects } from '@/features/sessions/RdpPane'

const CANVAS_WIDTH = 320
const CANVAS_HEIGHT = 320

function rectPayload(options: {
  x?: number
  y?: number
  width?: number
  height?: number
  stride?: number
  data: Uint8Array
}): Uint8Array {
  const width = options.width ?? 1
  const height = options.height ?? 1
  const stride = options.stride ?? width * 4
  const payload = new Uint8Array(24 + options.data.byteLength)
  const view = new DataView(payload.buffer)
  view.setInt32(0, options.x ?? 0, true)
  view.setInt32(4, options.y ?? 0, true)
  view.setUint32(8, width, true)
  view.setUint32(12, height, true)
  view.setUint32(16, stride, true)
  view.setUint32(20, options.data.byteLength, true)
  payload.set(options.data, 24)
  return payload
}

function framePayload(rects: Uint8Array[], sequence = 7): Uint8Array {
  const byteLength = 16 + rects.reduce((sum, rect) => sum + rect.byteLength, 0)
  const payload = new Uint8Array(byteLength)
  const view = new DataView(payload.buffer)
  view.setUint32(0, CANVAS_WIDTH, true)
  view.setUint32(4, CANVAS_HEIGHT, true)
  view.setUint32(8, sequence, true)
  view.setUint16(12, rects.length, true)
  view.setUint16(14, 0, true)
  let offset = 16
  for (const rect of rects) {
    payload.set(rect, offset)
    offset += rect.byteLength
  }
  return payload
}

describe('RDP frame decoding', () => {
  it('decodes the canonical rdp-frame-v1 dirty-rectangle stream', () => {
    const data = new Uint8Array([10, 20, 30, 255, 11, 21, 31, 255, 99, 99, 99, 255])
    const rects = decodeRdpRects({
      canvasWidth: CANVAS_WIDTH,
      canvasHeight: CANVAS_HEIGHT,
      data: rectPayload({ x: 2, y: 3, width: 2, height: 1, stride: 12, data })
    })

    expect(rects).toHaveLength(1)
    expect(rects?.[0]).toMatchObject({ x: 2, y: 3, width: 2, height: 1, stride: 12 })
    expect([...rects![0].data]).toEqual([...data])
  })

  it('rejects a complete Worker FRAME payload because main owns the OFSR header', () => {
    const rect = rectPayload({ x: 4, y: 5, data: new Uint8Array([1, 2, 3, 255]) })
    const rects = decodeRdpRects({
      canvasWidth: CANVAS_WIDTH,
      canvasHeight: CANVAS_HEIGHT,
      data: framePayload([rect])
    })

    expect(rects).toBeNull()
  })

  it('rejects frames outside the shared RDP display bounds', () => {
    const rect = rectPayload({ data: new Uint8Array([1, 2, 3, 255]) })
    expect(decodeRdpRects({ canvasWidth: 319, canvasHeight: CANVAS_HEIGHT, data: rect })).toBeNull()
    expect(decodeRdpRects({ canvasWidth: CANVAS_WIDTH, canvasHeight: 8193, data: rect })).toBeNull()
  })
})

describe('RDP Canvas2D composition', () => {
  const rafCallbacks: Array<FrameRequestCallback> = []
  const putImageData = vi.fn()
  const drawImage = vi.fn()
  let webglMode: 'none' | 'fail' | 'success' = 'none'
  let uploadedRows: Uint8Array | undefined
  let uploadPosition: [number, number] | undefined
  let contextKinds: WeakMap<HTMLCanvasElement, string>

  beforeEach(() => {
    rafCallbacks.length = 0
    putImageData.mockClear()
    drawImage.mockClear()
    webglMode = 'none'
    uploadedRows = undefined
    uploadPosition = undefined
    contextKinds = new WeakMap()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
      const existingKind = contextKinds.get(this)
      if (existingKind && existingKind !== kind) return null
      if (kind === 'webgl2') {
        if (webglMode === 'none') return null
        contextKinds.set(this, kind)
        if (webglMode === 'fail') {
          return {
            createShader: () => ({}),
            shaderSource: vi.fn(),
            compileShader: vi.fn(),
            getShaderParameter: () => false,
            getShaderInfoLog: () => 'shader failure',
            deleteShader: vi.fn()
          } as unknown as WebGL2RenderingContext
        }
        return {
          VERTEX_SHADER: 1,
          FRAGMENT_SHADER: 2,
          COMPILE_STATUS: 3,
          LINK_STATUS: 4,
          ARRAY_BUFFER: 5,
          STATIC_DRAW: 6,
          FLOAT: 7,
          TEXTURE_2D: 8,
          TEXTURE0: 9,
          TEXTURE_MIN_FILTER: 10,
          TEXTURE_MAG_FILTER: 11,
          TEXTURE_WRAP_S: 12,
          TEXTURE_WRAP_T: 13,
          NEAREST: 14,
          CLAMP_TO_EDGE: 15,
          RGBA: 16,
          UNSIGNED_BYTE: 17,
          UNPACK_ALIGNMENT: 18,
          UNPACK_FLIP_Y_WEBGL: 19,
          TRIANGLE_STRIP: 20,
          NO_ERROR: 0,
          createShader: () => ({}),
          shaderSource: vi.fn(),
          compileShader: vi.fn(),
          getShaderParameter: () => true,
          getShaderInfoLog: () => '',
          deleteShader: vi.fn(),
          createProgram: () => ({}),
          attachShader: vi.fn(),
          linkProgram: vi.fn(),
          getProgramParameter: () => true,
          getProgramInfoLog: () => '',
          deleteProgram: vi.fn(),
          getAttribLocation: (_program: unknown, name: string) => name === 'a_position' ? 0 : 1,
          createTexture: () => ({}),
          createBuffer: () => ({}),
          bindBuffer: vi.fn(),
          bufferData: vi.fn(),
          vertexAttribPointer: vi.fn(),
          useProgram: vi.fn(),
          getUniformLocation: () => ({}),
          uniform1i: vi.fn(),
          activeTexture: vi.fn(),
          bindTexture: vi.fn(),
          texParameteri: vi.fn(),
          texImage2D: vi.fn(),
          pixelStorei: vi.fn(),
          texSubImage2D: (_target: unknown, _level: unknown, x: number, y: number, ...args: unknown[]) => {
            uploadPosition = [x, y]
            uploadedRows = args[4] as Uint8Array
          },
          viewport: vi.fn(),
          enableVertexAttribArray: vi.fn(),
          drawArrays: vi.fn(),
          getError: () => 0,
          isContextLost: () => false,
          deleteTexture: vi.fn(),
          deleteBuffer: vi.fn()
        } as unknown as WebGL2RenderingContext
      }
      if (kind === '2d') {
        contextKinds.set(this, kind)
        return {
          createImageData: (width: number, height: number) => ({
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4)
          }),
          putImageData,
          drawImage
        } as unknown as CanvasRenderingContext2D
      }
      return null
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps latest-wins semantics and ACKs only after skipped frames or the displayed upload are consumed', () => {
    const canvas = document.createElement('canvas')
    const renderer = new RdpCanvasRenderer(canvas)
    const ack1 = vi.fn()
    const ack2 = vi.fn()
    const ack3 = vi.fn()

    renderer.enqueue({
      sequence: 1,
      canvasWidth: CANVAS_WIDTH,
      canvasHeight: CANVAS_HEIGHT,
      data: rectPayload({ data: new Uint8Array([0, 0, 255, 255]) })
    }, ack1)
    renderer.enqueue({
      sequence: 2,
      canvasWidth: CANVAS_WIDTH,
      canvasHeight: CANVAS_HEIGHT,
      data: rectPayload({ data: new Uint8Array([0, 255, 0, 255]) })
    }, ack2)
    renderer.enqueue({
      sequence: 3,
      canvasWidth: CANVAS_WIDTH,
      canvasHeight: CANVAS_HEIGHT,
      data: rectPayload({ data: new Uint8Array([255, 0, 0, 255]) })
    }, ack3)

    expect(ack1).toHaveBeenCalledTimes(1)
    expect(ack2).not.toHaveBeenCalled()
    expect(ack3).not.toHaveBeenCalled()

    rafCallbacks.shift()?.(0)

    expect(ack2).toHaveBeenCalledTimes(1)
    expect(ack3).toHaveBeenCalledTimes(1)
    expect(putImageData).toHaveBeenCalledTimes(1)
    const image = putImageData.mock.calls[0][0] as ImageData
    expect([...image.data]).toEqual([0, 0, 255, 255])
    renderer.dispose()
  })

  it('keeps the visible 2D fallback when WebGL initialization fails', () => {
    webglMode = 'fail'
    const canvas = document.createElement('canvas')
    const renderer = new RdpCanvasRenderer(canvas)

    renderer.enqueue({
      sequence: 1,
      canvasWidth: CANVAS_WIDTH,
      canvasHeight: CANVAS_HEIGHT,
      data: rectPayload({ data: new Uint8Array([0, 0, 255, 255]) })
    })
    rafCallbacks.shift()?.(0)

    expect(putImageData).toHaveBeenCalledTimes(1)
    renderer.dispose()
  })

  it('uploads top-down RDP rows in WebGL texture order and presents the result', () => {
    webglMode = 'success'
    const canvas = document.createElement('canvas')
    const renderer = new RdpCanvasRenderer(canvas)
    const topRow = new Uint8Array([1, 2, 3, 255])
    const bottomRow = new Uint8Array([4, 5, 6, 255])

    renderer.enqueue({
      sequence: 1,
      canvasWidth: CANVAS_WIDTH,
      canvasHeight: CANVAS_HEIGHT,
      data: rectPayload({ x: 7, y: 11, width: 1, height: 2, data: new Uint8Array([...topRow, ...bottomRow]) })
    })
    rafCallbacks.shift()?.(0)

    expect(uploadPosition).toEqual([7, CANVAS_HEIGHT - 11 - 2])
    expect([...uploadedRows!]).toEqual([...bottomRow, ...topRow])
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(putImageData).not.toHaveBeenCalled()
    renderer.dispose()
  })
})
