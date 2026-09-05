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

  beforeEach(() => {
    rafCallbacks.length = 0
    putImageData.mockClear()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind: string) => {
      if (kind === 'webgl2') return null
      if (kind === '2d') {
        return {
          createImageData: (width: number, height: number) => ({
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4)
          }),
          putImageData
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
})
