import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import {
  buildReply,
  parseGreeting,
  parseRequest,
  REPLY,
  Socks5Session,
  SOCKS_VERSION
} from '../../src/main/forward/socks5'

function fakeSocket(): { socket: Socket; written: Buffer[]; ended: Buffer[] } {
  const written: Buffer[] = []
  const ended: Buffer[] = []
  const socket = {
    write: (b: Buffer) => {
      written.push(Buffer.from(b))
      return true
    },
    end: (b?: Buffer) => {
      if (b) ended.push(Buffer.from(b))
    },
    remoteAddress: '127.0.0.1',
    remotePort: 51234,
    on: () => socket,
    destroy: () => {}
  } as unknown as Socket
  return { socket, written, ended }
}

describe('parseGreeting', () => {
  it('接受 no-auth', () => {
    const r = parseGreeting(Buffer.from([0x05, 0x01, 0x00]))
    expect(r).toEqual({ status: 'greeting-ok', consumed: 3 })
  })

  it('多方式列表里含 no-auth 也接受', () => {
    const r = parseGreeting(Buffer.from([0x05, 0x03, 0x00, 0x01, 0x02]))
    expect(r.status).toBe('greeting-ok')
  })

  it('数据不足时等待更多', () => {
    expect(parseGreeting(Buffer.from([0x05])).status).toBe('need-more')
    expect(parseGreeting(Buffer.from([0x05, 0x02, 0x00])).status).toBe('need-more')
  })

  it('拒绝非 5 版本与不支持 no-auth 的客户端', () => {
    expect(parseGreeting(Buffer.from([0x04, 0x01, 0x00]))).toMatchObject({ status: 'error' })
    expect(parseGreeting(Buffer.from([0x05, 0x01, 0x02]))).toMatchObject({ status: 'error' })
  })
})

describe('parseRequest', () => {
  it('IPv4 CONNECT', () => {
    // VER CMD RSV ATYP 1.2.3.4 :80
    const buf = Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50])
    expect(parseRequest(buf)).toEqual({
      status: 'request',
      consumed: 10,
      target: { host: '1.2.3.4', port: 80 }
    })
  })

  it('域名 CONNECT', () => {
    const host = 'example.com'
    const buf = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
      Buffer.from(host),
      Buffer.from([0x1f, 0x90]) // 8080
    ])
    expect(parseRequest(buf)).toEqual({
      status: 'request',
      consumed: buf.length,
      target: { host, port: 8080 }
    })
  })

  it('IPv6 CONNECT', () => {
    const addr = Buffer.alloc(16)
    addr[15] = 1 // ::1
    const buf = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), addr, Buffer.from([0x00, 0x16])])
    const r = parseRequest(buf)
    expect(r.status).toBe('request')
    if (r.status === 'request') {
      expect(r.target.port).toBe(22)
      expect(r.target.host).toBe('0:0:0:0:0:0:0:1')
    }
  })

  it('BIND/UDP 回 command not supported', () => {
    const bind = Buffer.from([0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50])
    expect(parseRequest(bind)).toMatchObject({
      status: 'error',
      rep: REPLY.commandNotSupported
    })
    const udp = Buffer.from([0x05, 0x03, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50])
    expect(parseRequest(udp)).toMatchObject({ status: 'error', rep: REPLY.commandNotSupported })
  })

  it('未知地址类型回 address type not supported', () => {
    expect(parseRequest(Buffer.from([0x05, 0x01, 0x00, 0x09, 0, 0]))).toMatchObject({
      status: 'error',
      rep: REPLY.addressTypeNotSupported
    })
  })

  it('分片数据等待更多', () => {
    expect(parseRequest(Buffer.from([0x05, 0x01, 0x00])).status).toBe('need-more')
    expect(parseRequest(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2])).status).toBe('need-more')
  })
})

describe('buildReply', () => {
  it('10 字节固定结构，BND 全零', () => {
    const r = buildReply(REPLY.succeeded)
    expect(r).toHaveLength(10)
    expect(r[0]).toBe(SOCKS_VERSION)
    expect(r[1]).toBe(0x00)
    expect(r[3]).toBe(0x01)
  })
})

describe('Socks5Session 状态机', () => {
  it('完整流程：握手 → 请求 → 回复成功 → 进入隧道', () => {
    const { socket, written } = fakeSocket()
    const onConnect = vi.fn((_target, reply: (rep: number) => void) => reply(REPLY.succeeded))
    const session = new Socks5Session(socket, onConnect, () => {})

    expect(session.feed(Buffer.from([0x05, 0x01, 0x00]))).toBeNull()
    expect(written[0]).toEqual(Buffer.from([0x05, 0x00]))

    const leftover = session.feed(
      Buffer.from([0x05, 0x01, 0x00, 0x01, 10, 0, 0, 5, 0x0c, 0xea]) // 10.0.0.5:3306
    )
    expect(leftover).toBeNull()
    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(onConnect.mock.calls[0][0]).toEqual({ host: '10.0.0.5', port: 3306 })
    expect(written[1]?.[1]).toBe(REPLY.succeeded)

    // 隧道阶段的数据原样返回给调用方转发
    const payload = Buffer.from('GET / HTTP/1.1\r\n')
    expect(session.feed(payload)).toEqual(payload)
  })

  it('请求包尾部多带的数据作为 leftover 返回', () => {
    const { socket } = fakeSocket()
    const session = new Socks5Session(socket, (_t, reply) => reply(REPLY.succeeded), () => {})
    session.feed(Buffer.from([0x05, 0x01, 0x00]))
    const extra = Buffer.from('hello')
    const leftover = session.feed(
      Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0x00, 0x50]), extra])
    )
    expect(leftover).toEqual(extra)
  })

  it('分片到达也能正确解析', () => {
    const { socket, written } = fakeSocket()
    const onConnect = vi.fn((_t, reply: (rep: number) => void) => reply(REPLY.succeeded))
    const session = new Socks5Session(socket, onConnect, () => {})
    session.feed(Buffer.from([0x05]))
    session.feed(Buffer.from([0x01, 0x00]))
    expect(written[0]).toEqual(Buffer.from([0x05, 0x00]))
    session.feed(Buffer.from([0x05, 0x01, 0x00, 0x03, 0x0b]))
    session.feed(Buffer.from('example.com'))
    expect(onConnect).not.toHaveBeenCalled()
    session.feed(Buffer.from([0x01, 0xbb])) // 443
    expect(onConnect.mock.calls[0][0]).toEqual({ host: 'example.com', port: 443 })
  })

  it('不支持的命令：回错误码并关闭，onError 收到原因', () => {
    const { socket, ended } = fakeSocket()
    const onError = vi.fn()
    const session = new Socks5Session(socket, () => {}, onError)
    session.feed(Buffer.from([0x05, 0x01, 0x00]))
    session.feed(Buffer.from([0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]))
    expect(ended[0]?.[1]).toBe(REPLY.commandNotSupported)
    expect(onError).toHaveBeenCalledWith('BIND 未实现')
  })

  it('目标连接失败时回 connection refused', () => {
    const { socket, written } = fakeSocket()
    const session = new Socks5Session(
      socket,
      (_t, reply) => reply(REPLY.connectionRefused),
      () => {}
    )
    session.feed(Buffer.from([0x05, 0x01, 0x00]))
    session.feed(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]))
    expect(written.at(-1)?.[1]).toBe(REPLY.connectionRefused)
  })
})
