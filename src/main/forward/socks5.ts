import type { Socket } from 'node:net'

/**
 * 极简 SOCKS5 服务端解析器（仅 no-auth + CONNECT）。
 * npm 上的 socksv5 已停止维护，这里自己实现协议状态机：
 *   握手：VER(0x05) NMETHODS METHODS... → 回 05 00（no-auth）
 *   请求：VER CMD RSV ATYP DST.ADDR DST.PORT → 交给上层用 forwardOut 连接
 *   回复：VER REP RSV ATYP BND.ADDR BND.PORT
 * BIND/UDP ASSOCIATE 一律回 0x07（command not supported）。
 */

export const SOCKS_VERSION = 0x05

export const REPLY = {
  succeeded: 0x00,
  generalFailure: 0x01,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressTypeNotSupported: 0x08
} as const

export type Socks5Target = { host: string; port: number }

/** 构造 SOCKS5 应答包（BND.ADDR 一律回 0.0.0.0:0，客户端不关心） */
export function buildReply(rep: number): Buffer {
  return Buffer.from([SOCKS_VERSION, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

type ParseResult =
  | { status: 'need-more' }
  | { status: 'greeting-ok'; consumed: number }
  | { status: 'request'; consumed: number; target: Socks5Target }
  | { status: 'error'; rep: number; reason: string }

/** 解析握手包（VER NMETHODS METHODS...） */
export function parseGreeting(buf: Buffer): ParseResult {
  if (buf.length < 2) return { status: 'need-more' }
  if (buf[0] !== SOCKS_VERSION) {
    return { status: 'error', rep: REPLY.generalFailure, reason: `不支持的 SOCKS 版本 ${buf[0]}` }
  }
  const nMethods = buf[1]
  if (buf.length < 2 + nMethods) return { status: 'need-more' }
  const methods = buf.subarray(2, 2 + nMethods)
  if (!methods.includes(0x00)) {
    return { status: 'error', rep: REPLY.generalFailure, reason: '客户端不支持无认证方式' }
  }
  return { status: 'greeting-ok', consumed: 2 + nMethods }
}

/** 解析请求包（VER CMD RSV ATYP ADDR PORT） */
export function parseRequest(buf: Buffer): ParseResult {
  if (buf.length < 4) return { status: 'need-more' }
  if (buf[0] !== SOCKS_VERSION) {
    return { status: 'error', rep: REPLY.generalFailure, reason: '协议版本不符' }
  }
  const cmd = buf[1]
  const atyp = buf[3]

  let host: string
  let offset: number
  if (atyp === 0x01) {
    // IPv4
    if (buf.length < 10) return { status: 'need-more' }
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
    offset = 8
  } else if (atyp === 0x03) {
    // 域名
    if (buf.length < 5) return { status: 'need-more' }
    const len = buf[4]
    if (buf.length < 5 + len + 2) return { status: 'need-more' }
    host = buf.subarray(5, 5 + len).toString('utf8')
    offset = 5 + len
  } else if (atyp === 0x04) {
    // IPv6
    if (buf.length < 22) return { status: 'need-more' }
    const parts: string[] = []
    for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(4 + i * 2).toString(16))
    host = parts.join(':')
    offset = 20
  } else {
    return { status: 'error', rep: REPLY.addressTypeNotSupported, reason: `不支持的地址类型 ${atyp}` }
  }

  if (cmd !== 0x01) {
    return {
      status: 'error',
      rep: REPLY.commandNotSupported,
      reason: cmd === 0x02 ? 'BIND 未实现' : 'UDP ASSOCIATE 未实现'
    }
  }

  const port = buf.readUInt16BE(offset)
  return { status: 'request', consumed: offset + 2, target: { host, port } }
}

/** 单连接的协议状态机：握手 → 请求 → 交给 onConnect 建隧道 */
export class Socks5Session {
  private phase: 'greeting' | 'request' | 'tunnel' = 'greeting'
  private buffer = Buffer.alloc(0)

  constructor(
    private readonly socket: Socket,
    private readonly onConnect: (target: Socks5Target, reply: (rep: number) => void) => void,
    private readonly onError: (reason: string) => void
  ) {}

  /** 返回进入隧道阶段后剩余的数据（应转发给远端） */
  feed(chunk: Buffer): Buffer | null {
    if (this.phase === 'tunnel') return chunk
    this.buffer = Buffer.concat([this.buffer, chunk])

    for (;;) {
      const inGreeting = this.phase === 'greeting'
      const result = inGreeting ? parseGreeting(this.buffer) : parseRequest(this.buffer)
      if (result.status === 'need-more') return null
      if (result.status === 'error') {
        this.socket.end(buildReply(result.rep))
        this.onError(result.reason)
        return null
      }
      if (result.status === 'greeting-ok') {
        this.buffer = this.buffer.subarray(result.consumed)
        this.phase = 'request'
        this.socket.write(Buffer.from([SOCKS_VERSION, 0x00]))
        continue
      }
      // request：进入隧道阶段，把握手后多带的数据交给调用方转发
      const leftover = this.buffer.subarray(result.consumed)
      this.buffer = Buffer.alloc(0)
      this.phase = 'tunnel'
      this.onConnect(result.target, (rep) => {
        this.socket.write(buildReply(rep))
      })
      return leftover.length > 0 ? leftover : null
    }
  }
}
