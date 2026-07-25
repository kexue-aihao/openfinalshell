import { createConnection, isIP, type Socket } from 'node:net'
import type { ProxyType } from '@shared/types'

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
  constructor(message: string) {
    super(message)
    this.name = 'ProxyError'
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

const SOCKS5_REPLY_TEXT: Record<number, string> = {
  0x01: '代理内部错误',
  0x02: '代理规则不允许该连接',
  0x03: '网络不可达',
  0x04: '主机不可达',
  0x05: '目标拒绝连接',
  0x06: 'TTL 超时',
  0x07: '代理不支持 CONNECT 命令',
  0x08: '代理不支持该地址类型'
}

export function proxyLabel(proxy: ResolvedProxy): string {
  return `${proxy.type === 'http' ? 'HTTP' : 'SOCKS5'} 代理 ${formatHostPort(proxy.host, proxy.port)}`
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
          ? '（代理未启动或端口不对）'
          : err.code === 'ENOTFOUND'
            ? '（代理主机名无法解析）'
            : err.code === 'ETIMEDOUT'
              ? '（超时）'
              : ''
      fail(`无法连接${proxyLabel(proxy)}${hint}：${err.message}`)
    }
    const onTimeout = (): void => fail(`连接${proxyLabel(proxy)}超时`)

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
      reject(new ProxyError(`代理连接出错（${stage}）：${err.message}`))
    }
    const onEnd = (): void => {
      cleanup()
      reject(new ProxyError(`代理在${stage}阶段关闭了连接`))
    }
    const onTimeout = (): void => {
      cleanup()
      reject(new ProxyError(`代理在${stage}阶段无响应（超时）`))
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
    throw new ProxyError(
      /关闭了连接|无响应/.test(msg)
        ? `${msg}（若该端口其实是 SOCKS5 代理，请把代理类型改成 SOCKS5）`
        : msg
    )
  }

  const text = head.toString('latin1')
  const status = /^HTTP\/\d(?:\.\d)?[ \t]+(\d{3})[ \t]*([^\r\n]*)/.exec(text)
  if (!status) throw new ProxyError(notHttpMessage(proxy, head))
  const code = Number(status[1])
  if (code === 200) return

  const reason = status[2].trim()
  const detail = reason ? `${code} ${reason}` : String(code)
  if (code === 407) {
    throw new ProxyError(`${proxyLabel(proxy)}要求身份验证（${detail}）：请填写代理用户名与密码`)
  }
  if (code === 403 || code === 405 || code === 501) {
    throw new ProxyError(`${proxyLabel(proxy)}拒绝建立到 ${hostport} 的隧道（${detail}）：可能未开放 CONNECT`)
  }
  throw new ProxyError(`${proxyLabel(proxy)}无法连接 ${hostport}（HTTP ${detail}）`)
}

function notHttpMessage(proxy: ResolvedProxy, head: Buffer): string {
  return (
    `${proxyLabel(proxy)}没有返回 HTTP 响应（开头是 0x${head.subarray(0, 2).toString('hex')}）：` +
    '该端口可能不是 HTTP 代理，若是 SOCKS5 请改用 SOCKS5 类型'
  )
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
      throw new ProxyError(`${proxyLabel(proxy)}返回的 HTTP 响应头过长，该端口可能不是 HTTP 代理`)
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

  const greeting = await readFrame(socket, (b) => (b.length >= 2 ? 2 : null), 'SOCKS5 协商')
  if (greeting[0] !== SOCKS5_VER) {
    throw new ProxyError(
      `${proxyLabel(proxy)}的应答不是 SOCKS5（版本字节 0x${greeting.subarray(0, 1).toString('hex')}）` +
        '：该端口可能是 HTTP 代理，请改用 HTTP 类型'
    )
  }
  switch (greeting[1]) {
    case AUTH_NONE:
      break
    case AUTH_USERPASS:
      if (!hasCred) {
        throw new ProxyError(`${proxyLabel(proxy)}要求用户名密码认证：请在代理设置里填写`)
      }
      await socks5Auth(socket, proxy)
      break
    case AUTH_UNACCEPTABLE:
      throw new ProxyError(
        `${proxyLabel(proxy)}拒绝了所有认证方式` +
          (hasCred ? '' : '：可能需要用户名与密码')
      )
    default:
      throw new ProxyError(`${proxyLabel(proxy)}选择了不支持的认证方式 0x${greeting[1].toString(16)}`)
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

  const reply = await readFrame(socket, socks5ReplySize, 'SOCKS5 请求')
  if (reply[0] !== SOCKS5_VER) {
    throw new ProxyError(`${proxyLabel(proxy)}的应答版本异常（0x${reply.subarray(0, 1).toString('hex')}）`)
  }
  if (reply[1] !== 0x00) {
    const why = SOCKS5_REPLY_TEXT[reply[1]] ?? `未知错误码 0x${reply[1].toString(16)}`
    throw new ProxyError(`${proxyLabel(proxy)}无法连接 ${hostport}：${why}`)
  }
}

async function socks5Auth(socket: Socket, proxy: ResolvedProxy): Promise<void> {
  const user = Buffer.from(proxy.username ?? '', 'utf8')
  const pass = Buffer.from(proxy.password ?? '', 'utf8')
  if (user.length > 255 || pass.length > 255) {
    throw new ProxyError('SOCKS5 的用户名与密码均不能超过 255 字节')
  }
  socket.write(
    Buffer.concat([
      Buffer.from([SOCKS5_AUTH_VER, user.length]),
      user,
      Buffer.from([pass.length]),
      pass
    ])
  )
  const res = await readFrame(socket, (b) => (b.length >= 2 ? 2 : null), 'SOCKS5 认证')
  // 子协商版本固定 0x01；状态非 0 即失败
  if (res[1] !== 0x00) {
    throw new ProxyError(`${proxyLabel(proxy)}认证失败：用户名或密码错误`)
  }
}

/** 应答长度取决于 ATYP，先看第 4 字节 */
function socks5ReplySize(buf: Buffer): number | null {
  if (buf.length < 5) return null
  const atyp = buf[3]
  const addrLen =
    atyp === ATYP_IPV4 ? 4 : atyp === ATYP_IPV6 ? 16 : atyp === ATYP_DOMAIN ? 1 + buf[4] : null
  if (addrLen === null) {
    throw new ProxyError(`SOCKS5 应答里的地址类型无法识别（0x${atyp.toString(16)}）`)
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
  if (name.length > 255) throw new ProxyError(`目标主机名过长（${name.length} 字节，上限 255）`)
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
