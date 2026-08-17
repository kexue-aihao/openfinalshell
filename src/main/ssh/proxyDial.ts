import { createConnection, isIP, type Socket } from 'node:net'
import type { ProxyType } from '@shared/types'
import { t } from '../services/i18n'

/**
 * 经 HTTP CONNECT / SOCKS5 代理拨号，返回可直接交给 ssh2 `config.sock` 的 socket。
 *
 * 两个关键实现细节：
 * 1. 握手完成后必须把多读到的字节 `unshift` 回读缓冲 —— 目标 SSH 服务器的版本 banner
 *    可能与代理应答在同一个 TCP 段里到达，丢掉就会卡死在
 *    "Connection lost before handshake"。ssh2 接过 sock 后自己 pause/resume，顺序不乱。
 * 2. 握手期间用 socket 自带 timeout 计时；交接前清零，之后由 readyTimeout 接管。
 */

/** 代理握手超时（不含之后的 SSH 握手，那段归 readyTimeout） */
const HANDSHAKE_TIMEOUT_MS = 15_000
/** HTTP 响应头上限，防不是 HTTP 代理时无限收数据 */
const MAX_HTTP_HEAD_BYTES = 16 * 1024

const SOCKS5_VER = 0x05
const SOCKS5_AUTH_VER = 0x01
const AUTH_NONE = 0x00
const AUTH_USERPASS = 0x02
const AUTH_UNACCEPTABLE = 0xff
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04

/**
 * 代理阶段的错误。文案已经是给用户看的了，friendlySshError 按 name 原样透出 ——
 * 否则代理的 ECONNREFUSED 会被翻成"目标主机端口未开放"，把人指到完全无关的方向。
 */
export class ProxyError extends Error {
  /** 内部标记，用于跨语言判定错误类别（不展示给用户） */
  kind?: string
  constructor(message: string, kind?: string) {
    super(message)
    this.name = 'ProxyError'
    if (kind) this.kind = kind
  }
}

/** 明文代理配置（密码已由调用方从 Vault 取出） */
export interface ResolvedProxy {
  type: Exclude<ProxyType, 'none'>
  host: string
  port: number
  username?: string
  password?: string
}

export interface ProxyTarget {
  host: string
  port: number
}

const SOCKS5_REPLY_KEY: Record<number, string> = {
  0x01: 'err.proxy.socks5GeneralFailure',
  0x02: 'err.proxy.socks5NotAllowed',
  0x03: 'err.proxy.socks5NetworkUnreachable',
  0x04: 'err.proxy.socks5HostUnreachable',
  0x05: 'err.proxy.socks5ConnectionRefused',
  0x06: 'err.proxy.socks5TtlExpired',
  0x07: 'err.proxy.socks5CommandNotSupported',
  0x08: 'err.proxy.socks5AddressTypeNotSupported'
}

export function proxyLabel(proxy: ResolvedProxy): string {
  return t('err.proxy.label', {
    type: proxy.type === 'http' ? 'HTTP' : 'SOCKS5',
    addr: formatHostPort(proxy.host, proxy.port)
  })
}

function formatHostPort(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`
}

export async function dialThroughProxy(proxy: ResolvedProxy, target: ProxyTarget): Promise<Socket> {
  const socket = await openProxySocket(proxy)
  try {
    if (proxy.type === 'http') await httpConnect(socket, proxy, target)
    else await socks5Connect(socket, proxy, target)
  } catch (err) {
    socket.destroy()
    throw err
  }
  // 交接给 ssh2：停掉握手计时，保持 paused（ssh2 会在挂上 data 后自己 resume）
  socket.setTimeout(0)
  socket.pause()
  return socket
}

function openProxySocket(proxy: ResolvedProxy): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: proxy.host, port: proxy.port })
    socket.setNoDelay(true)
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS)

    const cleanup = (): void => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
    }
    const fail = (msg: string): void => {
      cleanup()
      socket.destroy()
      reject(new ProxyError(msg))
    }
    const onConnect = (): void => {
      cleanup()
      resolve(socket)
    }
    const onError = (err: NodeJS.ErrnoException): void => {
      const hint =
        err.code === 'ECONNREFUSED'
          ? t('err.proxy.hintRefused')
          : err.code === 'ENOTFOUND'
            ? t('err.proxy.hintNotFound')
            : err.code === 'ETIMEDOUT'
              ? t('err.proxy.hintTimeout')
              : ''
      fail(t('err.proxy.connectFailed', { label: proxyLabel(proxy), hint, message: err.message }))
    }
    const onTimeout = (): void => fail(t('err.proxy.connectTimeout', { label: proxyLabel(proxy) }))

    socket.on('connect', onConnect).on('error', onError).on('timeout', onTimeout)
  })
}

/**
 * 收满一帧。`sizeOf` 返回整帧字节数，返回 null 表示还要继续收。
 * 收到的多余字节会 unshift 回流，供下一次读取或 ssh2 消费。
 */
function readFrame(
  socket: Socket,
  sizeOf: (buf: Buffer) => number | null,
  stage: string
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buf: Buffer = Buffer.alloc(0)

    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
      socket.off('timeout', onTimeout)
    }
    const onData = (chunk: Buffer): void => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      let size: number | null
      try {
        size = sizeOf(buf)
      } catch (err) {
        cleanup()
        reject(err instanceof Error ? err : new ProxyError(String(err)))
        return
      }
      if (size === null) return
      cleanup()
      // 先 pause 再 unshift：非流动状态下回推才不会被当场丢弃
      socket.pause()
      if (buf.length > size) socket.unshift(buf.subarray(size))
      resolve(buf.subarray(0, size))
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(new ProxyError(t('err.proxy.stageError', { stage, message: err.message })))
    }
    const onEnd = (): void => {
      cleanup()
      reject(new ProxyError(t('err.proxy.stageClosed', { stage }), 'closed'))
    }
    const onTimeout = (): void => {
      cleanup()
      reject(new ProxyError(t('err.proxy.stageNoResponse', { stage }), 'noResponse'))
    }

    socket.on('data', onData).on('error', onError).on('end', onEnd).on('timeout', onTimeout)
    socket.resume()
  })
}

// ---------------- HTTP CONNECT ----------------

async function httpConnect(socket: Socket, proxy: ResolvedProxy, target: ProxyTarget): Promise<void> {
  const hostport = formatHostPort(target.host, target.port)
  const lines = [`CONNECT ${hostport} HTTP/1.1`, `Host: ${hostport}`]
  if (proxy.username) {
    const cred = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`, 'utf8').toString('base64')
    lines.push(`Proxy-Authorization: Basic ${cred}`)
  }
  lines.push('Proxy-Connection: Keep-Alive', '', '')
  socket.write(lines.join('\r\n'))

  let head: Buffer
  try {
    head = await readFrame(socket, headEndFor(proxy), 'HTTP CONNECT')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 把 CONNECT 发给 SOCKS 端口时，对方读不懂就直接断开 —— 这是最常见的配错
    const closedOrSilent = err instanceof ProxyError && (err.kind === 'closed' || err.kind === 'noResponse')
    throw new ProxyError(closedOrSilent ? t('err.proxy.httpMaybeSocks5', { message: msg }) : msg)
  }

  const text = head.toString('latin1')
  const status = /^HTTP\/\d(?:\.\d)?[ \t]+(\d{3})[ \t]*([^\r\n]*)/.exec(text)
  if (!status) throw new ProxyError(notHttpMessage(proxy, head))
  const code = Number(status[1])
  if (code === 200) return

  const reason = status[2].trim()
  const detail = reason ? `${code} ${reason}` : String(code)
  if (code === 407) {
    throw new ProxyError(t('err.proxy.httpAuthRequired', { label: proxyLabel(proxy), detail }))
  }
  if (code === 403 || code === 405 || code === 501) {
    throw new ProxyError(
      t('err.proxy.httpTunnelRefused', { label: proxyLabel(proxy), target: hostport, detail })
    )
  }
  throw new ProxyError(
    t('err.proxy.httpConnectFailed', { label: proxyLabel(proxy), target: hostport, detail })
  )
}

function notHttpMessage(proxy: ResolvedProxy, head: Buffer): string {
  return t('err.proxy.notHttp', {
    label: proxyLabel(proxy),
    prefix: head.subarray(0, 2).toString('hex')
  })
}

/**
 * 响应头结束位置；容忍只用 LF 的实现。
 * 前 5 字节不是 "HTTP/" 就立刻判死 —— SOCKS 端口常见的反应是回两个字节然后沉默，
 * 傻等满响应头会白白卡到握手超时。
 */
function headEndFor(proxy: ResolvedProxy): (buf: Buffer) => number | null {
  return (buf) => {
    if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') !== 'HTTP/') {
      throw new ProxyError(notHttpMessage(proxy, buf))
    }
    const crlf = buf.indexOf('\r\n\r\n')
    const lf = buf.indexOf('\n\n')
    const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf >= 0 ? lf + 2 : -1
    if (end > 0) return end
    if (buf.length > MAX_HTTP_HEAD_BYTES) {
      throw new ProxyError(t('err.proxy.httpHeadTooLong', { label: proxyLabel(proxy) }))
    }
    return null
  }
}

// ---------------- SOCKS5 (RFC 1928 / 1929) ----------------

async function socks5Connect(
  socket: Socket,
  proxy: ResolvedProxy,
  target: ProxyTarget
): Promise<void> {
  const hasCred = Boolean(proxy.username)
  const methods = hasCred ? [AUTH_NONE, AUTH_USERPASS] : [AUTH_NONE]
  socket.write(Buffer.from([SOCKS5_VER, methods.length, ...methods]))

  const greeting = await readFrame(
    socket,
    (b) => (b.length >= 2 ? 2 : null),
    t('err.proxy.stageSocks5Negotiate')
  )
  if (greeting[0] !== SOCKS5_VER) {
    throw new ProxyError(
      t('err.proxy.notSocks5', {
        label: proxyLabel(proxy),
        version: greeting.subarray(0, 1).toString('hex')
      })
    )
  }
  switch (greeting[1]) {
    case AUTH_NONE:
      break
    case AUTH_USERPASS:
      if (!hasCred) {
        throw new ProxyError(t('err.proxy.socks5AuthRequired', { label: proxyLabel(proxy) }))
      }
      await socks5Auth(socket, proxy)
      break
    case AUTH_UNACCEPTABLE:
      throw new ProxyError(
        t('err.proxy.socks5NoAcceptableAuth', {
          label: proxyLabel(proxy),
          suffix: hasCred ? '' : t('err.proxy.socks5MaybeNeedCred')
        })
      )
    default:
      throw new ProxyError(
        t('err.proxy.socks5UnsupportedAuthMethod', {
          label: proxyLabel(proxy),
          method: greeting[1].toString(16)
        })
      )
  }

  const hostport = formatHostPort(target.host, target.port)
  const port = Buffer.alloc(2)
  port.writeUInt16BE(target.port)
  socket.write(
    Buffer.concat([
      Buffer.from([SOCKS5_VER, CMD_CONNECT, 0x00]),
      encodeAddress(target.host),
      port
    ])
  )

  const reply = await readFrame(socket, socks5ReplySize, t('err.proxy.stageSocks5Request'))
  if (reply[0] !== SOCKS5_VER) {
    throw new ProxyError(
      t('err.proxy.socks5BadReplyVersion', {
        label: proxyLabel(proxy),
        version: reply.subarray(0, 1).toString('hex')
      })
    )
  }
  if (reply[1] !== 0x00) {
    const replyKey = SOCKS5_REPLY_KEY[reply[1]]
    const why = replyKey
      ? t(replyKey)
      : t('err.proxy.socks5UnknownCode', { code: reply[1].toString(16) })
    throw new ProxyError(
      t('err.proxy.socks5ConnectFailed', { label: proxyLabel(proxy), target: hostport, reason: why })
    )
  }
}

async function socks5Auth(socket: Socket, proxy: ResolvedProxy): Promise<void> {
  const user = Buffer.from(proxy.username ?? '', 'utf8')
  const pass = Buffer.from(proxy.password ?? '', 'utf8')
  if (user.length > 255 || pass.length > 255) {
    throw new ProxyError(t('err.proxy.socks5CredTooLong'))
  }
  socket.write(
    Buffer.concat([
      Buffer.from([SOCKS5_AUTH_VER, user.length]),
      user,
      Buffer.from([pass.length]),
      pass
    ])
  )
  const res = await readFrame(
    socket,
    (b) => (b.length >= 2 ? 2 : null),
    t('err.proxy.stageSocks5Auth')
  )
  // 子协商版本固定 0x01；状态非 0 即失败
  if (res[1] !== 0x00) {
    throw new ProxyError(t('err.proxy.socks5AuthFailed', { label: proxyLabel(proxy) }))
  }
}

/** 应答长度取决于 ATYP，先看第 4 字节 */
function socks5ReplySize(buf: Buffer): number | null {
  if (buf.length < 5) return null
  const atyp = buf[3]
  const addrLen =
    atyp === ATYP_IPV4 ? 4 : atyp === ATYP_IPV6 ? 16 : atyp === ATYP_DOMAIN ? 1 + buf[4] : null
  if (addrLen === null) {
    throw new ProxyError(t('err.proxy.socks5UnknownAtyp', { atyp: atyp.toString(16) }))
  }
  const total = 4 + addrLen + 2
  return buf.length >= total ? total : null
}

/** 域名优先交给代理解析（客户端可能根本解析不了目标名） */
function encodeAddress(host: string): Buffer {
  const kind = isIP(host)
  if (kind === 4) return Buffer.concat([Buffer.from([ATYP_IPV4]), ipv4ToBytes(host)])
  if (kind === 6) return Buffer.concat([Buffer.from([ATYP_IPV6]), ipv6ToBytes(host)])
  const name = Buffer.from(host, 'utf8')
  if (name.length > 255) throw new ProxyError(t('err.proxy.targetHostTooLong', { len: name.length }))
  return Buffer.concat([Buffer.from([ATYP_DOMAIN, name.length]), name])
}

function ipv4ToBytes(host: string): Buffer {
  return Buffer.from(host.split('.').map((n) => Number(n) & 0xff))
}

/** 仅在 isIP()===6 时调用，故不做合法性校验；支持 :: 压缩与内嵌 IPv4 */
function ipv6ToBytes(host: string): Buffer {
  const halves = host.split('%')[0].split('::')
  const expand = (part: string): number[] => {
    if (part === '') return []
    const out: number[] = []
    for (const group of part.split(':')) {
      if (group.includes('.')) {
        const v4 = ipv4ToBytes(group)
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
      } else {
        out.push(parseInt(group, 16))
      }
    }
    return out
  }
  const head = expand(halves[0])
  const tail = halves.length > 1 ? expand(halves[1]) : []
  const groups = [...head, ...new Array(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail]
  const buf = Buffer.alloc(16)
  for (let i = 0; i < 8; i++) buf.writeUInt16BE(groups[i] & 0xffff, i * 2)
  return buf
}
