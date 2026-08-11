import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_PORT,
  MAX_DATAGRAM_BYTES,
  MAX_FRAME_BYTES,
  FrameReader,
  decodeDiscovery,
  encodeDiscovery,
  encodeFrame,
  type DiscoveryAnnounce,
  type SyncFrame
} from '../../src/main/lansync/protocol'

/**
 * 线上协议的编解码。UDP 侧盯"垃圾一律静默丢弃"（那个端口收到什么都不奇怪），
 * TCP 侧盯"帧边界不可信就抛"（对端自称要说话，说不成话就断连）——
 * 两侧的失败语义刻意相反，各有一组用例钉住。
 */

const probe = {
  magic: 'OFSSYNC1',
  proto: 1,
  kind: 'probe',
  deviceId: 'dev-a',
  deviceName: 'PC-A'
} as const

const announce: DiscoveryAnnounce = {
  magic: 'OFSSYNC1',
  proto: 1,
  kind: 'announce',
  deviceId: 'dev-b',
  deviceName: 'PC-B',
  appVersion: '0.17.1',
  tcpPort: 50000,
  sessionId: 's-1'
}

describe('发现报文（UDP）', () => {
  it('probe / announce 编解码往返', () => {
    expect(decodeDiscovery(encodeDiscovery(probe))).toEqual(probe)
    expect(decodeDiscovery(encodeDiscovery(announce))).toEqual(announce)
  })

  it('垃圾一律 null：非 JSON / 魔数不符 / 版本不符 / kind 未知 / 端口越界 / 超长', () => {
    expect(decodeDiscovery(Buffer.from('not json'))).toBeNull()
    expect(decodeDiscovery(encodeDiscovery({ ...probe, magic: 'NOPE' } as never))).toBeNull()
    expect(decodeDiscovery(encodeDiscovery({ ...probe, proto: 2 } as never))).toBeNull()
    expect(decodeDiscovery(Buffer.from(JSON.stringify({ ...probe, kind: 'hi' })))).toBeNull()
    expect(decodeDiscovery(encodeDiscovery({ ...announce, tcpPort: 0 } as never))).toBeNull()
    expect(decodeDiscovery(encodeDiscovery({ ...announce, tcpPort: 70000 } as never))).toBeNull()
    const oversized = Buffer.alloc(MAX_DATAGRAM_BYTES + 1, 0x20)
    expect(decodeDiscovery(oversized)).toBeNull()
  })

  it('端口常量是固定值（两端必须一致才能互相发现）', () => {
    expect(DISCOVERY_PORT).toBe(52133)
  })
})

describe('传输帧（TCP）', () => {
  function collect(): { frames: SyncFrame[]; reader: FrameReader } {
    const frames: SyncFrame[] = []
    const reader = new FrameReader((f) => frames.push(f))
    return { frames, reader }
  }

  const hello: SyncFrame = {
    kind: 'hello',
    magic: 'OFSSYNC1',
    proto: 1,
    deviceId: 'dev-a',
    deviceName: 'PC-A',
    appVersion: '0.17.1',
    senderPub: Buffer.alloc(44, 7).toString('base64')
  }
  const payload: SyncFrame = { kind: 'payload', envelope: '{"app":"openfinalshell"}' }

  it('一帧整投递、一 chunk 多帧、逐字节喂 —— 三种到达形态回调一致', () => {
    const whole = collect()
    whole.reader.feed(encodeFrame(hello))
    expect(whole.frames).toEqual([hello])

    const multi = collect()
    multi.reader.feed(Buffer.concat([encodeFrame(hello), encodeFrame(payload), encodeFrame({ kind: 'received' })]))
    expect(multi.frames).toEqual([hello, payload, { kind: 'received' }])

    // TCP 最恶劣形态：一次一个字节（长度前缀也会跨 chunk）
    const drip = collect()
    const bytes = Buffer.concat([encodeFrame(hello), encodeFrame(payload)])
    for (let i = 0; i < bytes.byteLength; i++) drip.reader.feed(bytes.subarray(i, i + 1))
    expect(drip.frames).toEqual([hello, payload])
  })

  it('恶意长度前缀在**读到前缀那一刻**就抛，不等字节攒够', () => {
    const { reader } = collect()
    const head = Buffer.allocUnsafe(4)
    head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    // 只喂 4 字节前缀，一个正文字节都不给 —— 等待本身就是攻击（内存被填满）
    expect(() => reader.feed(head)).toThrow(/帧长度不合法/)
  })

  it('零长度帧不合法', () => {
    const { reader } = collect()
    const head = Buffer.alloc(4, 0)
    expect(() => reader.feed(head)).toThrow(/帧长度不合法/)
  })

  it('正文不是 JSON / 结构不合法 → 抛（调用方据此断连）', () => {
    const bad = collect()
    const junk = Buffer.from('junk-not-json', 'utf8')
    const head = Buffer.allocUnsafe(4)
    head.writeUInt32BE(junk.byteLength, 0)
    expect(() => bad.reader.feed(Buffer.concat([head, junk]))).toThrow(/JSON/)

    const wrongShape = collect()
    const body = Buffer.from(JSON.stringify({ kind: 'hello', magic: 'NOPE' }), 'utf8')
    const head2 = Buffer.allocUnsafe(4)
    head2.writeUInt32BE(body.byteLength, 0)
    expect(() => wrongShape.reader.feed(Buffer.concat([head2, body]))).toThrow(/结构不合法/)
  })

  it('error 帧携带 i18n 键与参数（两端同应用、各自本地渲染）', () => {
    const { frames, reader } = collect()
    reader.feed(encodeFrame({ kind: 'error', code: 'err.sync.busy', params: { name: 'PC-C' } }))
    expect(frames).toEqual([{ kind: 'error', code: 'err.sync.busy', params: { name: 'PC-C' } }])
  })
})
