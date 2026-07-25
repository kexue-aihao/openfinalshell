import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { dialThroughProxy, type ResolvedProxy } from '../../src/main/ssh/proxyDial'

/**
 * 用真实 TCP 假代理跑协议，不 mock socket —— 这样 unshift 回推、分段到达、
 * 认证子协商这些真实行为才会被覆盖到。
 */

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        })
    )
  )
})

async function listen(onConn: (socket: Socket) => void): Promise<number> {
  const server = createServer(onConn)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function proxyAt(port: number, extra: Partial<ResolvedProxy> = {}): ResolvedProxy {
  return { type: 'socks5', host: '127.0.0.1', port, ...extra }
}

/**
 * 假服务端的读取器：一个常驻 'data' 监听把字节全存下来再按需切。
 * 不能"读完就摘监听" —— socket 仍在 flowing 模式，两次读之间到达的字节会被直接丢掉。
 */
class Reader {
  private buf: Buffer = Buffer.alloc(0)
  private pending: { want: (b: Buffer) => number | null; resolve: (b: Buffer) => void } | null = null

  constructor(socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk])
      this.serve()
    })
  }

  private serve(): void {
    const p = this.pending
    if (!p) return
    const size = p.want(this.buf)
    if (size === null) return
    this.pending = null
    const out = this.buf.subarray(0, size)
    this.buf = this.buf.subarray(size)
    p.resolve(out)
  }

  private read(want: (b: Buffer) => number | null): Promise<Buffer> {
    return new Promise((resolve) => {
      this.pending = { want, resolve }
      this.serve()
    })
  }

  exactly(n: number): Promise<Buffer> {
    return this.read((b) => (b.length >= n ? n : null))
  }

  async untilDoubleCrlf(): Promise<string> {
    const head = await this.read((b) => {
      const end = b.indexOf('\r\n\r\n')
      return end >= 0 ? end + 4 : null
    })
    return head.toString('latin1')
  }
}

/** 握手后第一段 payload —— 用来验证 banner 没被握手解析吞掉 */
function firstPayload(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve)
    socket.once('error', reject)
    // ssh2 会自己 resume；测试里手动放行
    socket.resume()
  })
}

const BANNER = 'SSH-2.0-OpenSSH_10.0p2 Debian-1\r\n'

describe('HTTP CONNECT 代理', () => {
  it('隧道建成，并且与应答同段到达的 SSH banner 不丢', async () => {
    let request = ''
    const port = await listen(async (socket) => {
      request = await new Reader(socket).untilDoubleCrlf()
      // 故意把 200 应答和 banner 塞进同一个 write（同一个 TCP 段）
      socket.write(`HTTP/1.1 200 Connection established\r\n\r\n${BANNER}`)
    })

    const sock = await dialThroughProxy(proxyAt(port, { type: 'http' }), {
      host: 'example.com',
      port: 22
    })
    expect(request.split('\r\n')[0]).toBe('CONNECT example.com:22 HTTP/1.1')
    expect(request).toContain('Host: example.com:22')
    expect(request).not.toContain('Proxy-Authorization')
    await expect(firstPayload(sock)).resolves.toEqual(Buffer.from(BANNER))
    sock.destroy()
  })

  it('带凭据时发 Basic 认证头', async () => {
    let request = ''
    const port = await listen(async (socket) => {
      request = await new Reader(socket).untilDoubleCrlf()
      socket.write('HTTP/1.1 200 OK\r\n\r\n')
    })
    const sock = await dialThroughProxy(
      proxyAt(port, { type: 'http', username: 'u', password: 'p@ss' }),
      { host: '10.0.0.1', port: 2222 }
    )
    const expected = Buffer.from('u:p@ss', 'utf8').toString('base64')
    expect(request).toContain(`Proxy-Authorization: Basic ${expected}`)
    sock.destroy()
  })

  it('407 提示填代理凭据', async () => {
    const port = await listen((socket) => {
      void new Reader(socket).untilDoubleCrlf().then(() => {
        socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      })
    })
    await expect(
      dialThroughProxy(proxyAt(port, { type: 'http' }), { host: 'h', port: 22 })
    ).rejects.toThrow(/407.*代理用户名与密码/s)
  })

  it('403 说明是代理拒绝，不是目标问题', async () => {
    const port = await listen((socket) => {
      void new Reader(socket).untilDoubleCrlf().then(() => socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'))
    })
    await expect(
      dialThroughProxy(proxyAt(port, { type: 'http' }), { host: 'blocked.example', port: 22 })
    ).rejects.toThrow(/拒绝建立到 blocked\.example:22 的隧道（403 Forbidden）/)
  })

  // SOCKS 端口收到 CONNECT 后常见反应是回几个字节然后沉默：必须立刻判死，不能等到握手超时
  it('对方根本不是 HTTP 代理时立即如实说明，不干等超时', async () => {
    const port = await listen((socket) => {
      void new Reader(socket)
        .untilDoubleCrlf()
        .then(() => socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00])))
    })
    const started = Date.now()
    await expect(
      dialThroughProxy(proxyAt(port, { type: 'http' }), { host: 'h', port: 22 })
    ).rejects.toThrow(/没有返回 HTTP 响应（开头是 0x0500）.*不是 HTTP 代理/s)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('把 CONNECT 发给 SOCKS 端口（对方直接断开）时给出改类型的提示', async () => {
    const port = await listen((socket) => {
      void new Reader(socket).untilDoubleCrlf().then(() => socket.end())
    })
    await expect(
      dialThroughProxy(proxyAt(port, { type: 'http' }), { host: 'h', port: 22 })
    ).rejects.toThrow(/请把代理类型改成 SOCKS5/)
  })

  it('IPv6 目标在 CONNECT 行里加方括号', async () => {
    let request = ''
    const port = await listen(async (socket) => {
      request = await new Reader(socket).untilDoubleCrlf()
      socket.write('HTTP/1.1 200 OK\r\n\r\n')
    })
    const sock = await dialThroughProxy(proxyAt(port, { type: 'http' }), {
      host: '2001:db8::1',
      port: 22
    })
    expect(request.split('\r\n')[0]).toBe('CONNECT [2001:db8::1]:22 HTTP/1.1')
    sock.destroy()
  })
})

// ---------------- SOCKS5 ----------------

interface Socks5Capture {
  greeting?: Buffer
  auth?: Buffer
  request?: Buffer
}

/**
 * 假 SOCKS5 服务端。opts.rep 非 0 时回错误码；requireAuth 时走 RFC1929 子协商。
 * withBanner=true 会把应答与 banner 合并成一段发出，用于验证 unshift。
 */
async function socks5Server(opts: {
  capture: Socks5Capture
  requireAuth?: boolean
  authOk?: boolean
  rep?: number
  withBanner?: boolean
  replyAtyp?: 'ipv4' | 'domain' | 'ipv6'
}): Promise<number> {
  return listen(async (socket) => {
    const cap = opts.capture
    const r = new Reader(socket)
    const greeting = await r.exactly(2)
    const methods = await r.exactly(greeting[1])
    cap.greeting = Buffer.concat([greeting, methods])

    if (opts.requireAuth) {
      socket.write(Buffer.from([0x05, 0x02]))
      const head = await r.exactly(2)
      const user = await r.exactly(head[1])
      const plenBuf = await r.exactly(1)
      const pass = await r.exactly(plenBuf[0])
      cap.auth = Buffer.concat([head, user, plenBuf, pass])
      socket.write(Buffer.from([0x01, opts.authOk === false ? 0x01 : 0x00]))
      if (opts.authOk === false) return
    } else {
      socket.write(Buffer.from([0x05, 0x00]))
    }

    const reqHead = await r.exactly(4)
    const atyp = reqHead[3]
    let addr: Buffer
    if (atyp === 0x01) addr = await r.exactly(4)
    else if (atyp === 0x04) addr = await r.exactly(16)
    else {
      const len = await r.exactly(1)
      addr = Buffer.concat([len, await r.exactly(len[0])])
    }
    const portBuf = await r.exactly(2)
    cap.request = Buffer.concat([reqHead, addr, portBuf])

    const rep = opts.rep ?? 0x00
    const bnd =
      opts.replyAtyp === 'domain'
        ? Buffer.from([0x03, 0x03, 0x61, 0x62, 0x63])
        : opts.replyAtyp === 'ipv6'
          ? Buffer.concat([Buffer.from([0x04]), Buffer.alloc(16)])
          : Buffer.from([0x01, 0, 0, 0, 0])
    const reply = Buffer.concat([Buffer.from([0x05, rep, 0x00]), bnd, Buffer.from([0, 0])])
    socket.write(opts.withBanner ? Buffer.concat([reply, Buffer.from(BANNER)]) : reply)
  })
}

describe('SOCKS5 代理', () => {
  it('no-auth 打通，域名交给代理解析，banner 不丢', async () => {
    const cap: Socks5Capture = {}
    const port = await socks5Server({ capture: cap, withBanner: true })
    const sock = await dialThroughProxy(proxyAt(port), { host: 'example.com', port: 50035 })

    expect([...(cap.greeting ?? [])]).toEqual([0x05, 0x01, 0x00])
    const req = cap.request!
    expect([...req.subarray(0, 4)]).toEqual([0x05, 0x01, 0x00, 0x03])
    expect(req[4]).toBe('example.com'.length)
    expect(req.subarray(5, 5 + req[4]).toString()).toBe('example.com')
    expect(req.readUInt16BE(req.length - 2)).toBe(50035)
    await expect(firstPayload(sock)).resolves.toEqual(Buffer.from(BANNER))
    sock.destroy()
  })

  it('IPv4 目标用 ATYP=1 的数值形式', async () => {
    const cap: Socks5Capture = {}
    const port = await socks5Server({ capture: cap })
    // 用 RFC 5737 的文档专用地址，别把真实主机 IP 写进用例
    const sock = await dialThroughProxy(proxyAt(port), { host: '203.0.113.7', port: 22 })
    expect([...cap.request!]).toEqual([0x05, 0x01, 0x00, 0x01, 203, 0, 113, 7, 0x00, 0x16])
    sock.destroy()
  })

  it('IPv6 目标用 ATYP=4，:: 压缩与内嵌 IPv4 都按 RFC 展开', async () => {
    const cap1: Socks5Capture = {}
    const p1 = await socks5Server({ capture: cap1 })
    const s1 = await dialThroughProxy(proxyAt(p1), { host: '2001:db8::1', port: 22 })
    expect(cap1.request!.subarray(4, 20).toString('hex')).toBe('20010db8000000000000000000000001')
    s1.destroy()

    const cap2: Socks5Capture = {}
    const p2 = await socks5Server({ capture: cap2 })
    const s2 = await dialThroughProxy(proxyAt(p2), { host: '::ffff:192.168.1.9', port: 22 })
    expect(cap2.request!.subarray(4, 20).toString('hex')).toBe('00000000000000000000ffffc0a80109')
    s2.destroy()
  })

  it('用户名密码认证走 RFC1929 编码', async () => {
    const cap: Socks5Capture = {}
    const port = await socks5Server({ capture: cap, requireAuth: true })
    const sock = await dialThroughProxy(proxyAt(port, { username: 'alice', password: 'sec' }), {
      host: 'h.example',
      port: 22
    })
    expect([...(cap.greeting ?? [])]).toEqual([0x05, 0x02, 0x00, 0x02])
    expect([...cap.auth!]).toEqual([0x01, 5, ...Buffer.from('alice'), 3, ...Buffer.from('sec')])
    sock.destroy()
  })

  it('认证失败给出明确文案', async () => {
    const cap: Socks5Capture = {}
    const port = await socks5Server({ capture: cap, requireAuth: true, authOk: false })
    await expect(
      dialThroughProxy(proxyAt(port, { username: 'a', password: 'bad' }), { host: 'h', port: 22 })
    ).rejects.toThrow(/认证失败：用户名或密码错误/)
  })

  it('代理要求认证但没填凭据时不静默失败', async () => {
    const cap: Socks5Capture = {}
    const port = await socks5Server({ capture: cap, requireAuth: true })
    await expect(dialThroughProxy(proxyAt(port), { host: 'h', port: 22 })).rejects.toThrow(
      /要求用户名密码认证/
    )
  })

  it('REP 错误码翻译成人话', async () => {
    const cases: Array<[number, RegExp]> = [
      [0x05, /目标拒绝连接/],
      [0x04, /主机不可达/],
      [0x02, /代理规则不允许该连接/]
    ]
    for (const [rep, re] of cases) {
      const cap: Socks5Capture = {}
      const port = await socks5Server({ capture: cap, rep })
      await expect(
        dialThroughProxy(proxyAt(port), { host: 'nope.example', port: 22 })
      ).rejects.toThrow(re)
    }
  })

  it('变长应答（ATYP=域名 / IPv6）也能正确断帧', async () => {
    for (const replyAtyp of ['domain', 'ipv6'] as const) {
      const cap: Socks5Capture = {}
      const port = await socks5Server({ capture: cap, replyAtyp, withBanner: true })
      const sock = await dialThroughProxy(proxyAt(port), { host: 'h.example', port: 22 })
      await expect(firstPayload(sock)).resolves.toEqual(Buffer.from(BANNER))
      sock.destroy()
    }
  })

  it('对方其实是 HTTP 代理时提示改类型', async () => {
    const port = await listen((socket) => {
      socket.once('data', () => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'))
    })
    await expect(dialThroughProxy(proxyAt(port), { host: 'h', port: 22 })).rejects.toThrow(
      /不是 SOCKS5.*请改用 HTTP 类型/s
    )
  })

  it('逐字节挤牙膏式到达也能拼帧', async () => {
    const cap: Socks5Capture = {}
    const port = await listen(async (socket) => {
      const reader = new Reader(socket)
      cap.greeting = await reader.exactly(3)
      // 分两段发协商应答，每段 1 字节
      socket.write(Buffer.from([0x05]))
      await new Promise((r) => setTimeout(r, 20))
      socket.write(Buffer.from([0x00]))
      const reqHead = await reader.exactly(4)
      const len = await reader.exactly(1)
      await reader.exactly(len[0] + 2)
      cap.request = reqHead
      const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
      for (const byte of reply) {
        socket.write(Buffer.from([byte]))
        await new Promise((r) => setTimeout(r, 2))
      }
      socket.write(Buffer.from(BANNER))
    })
    const sock = await dialThroughProxy(proxyAt(port), { host: 'h.example', port: 22 })
    await expect(firstPayload(sock)).resolves.toEqual(Buffer.from(BANNER))
    sock.destroy()
  })
})

describe('代理不可用', () => {
  it('端口没人监听时报"代理未启动或端口不对"', async () => {
    // 先占一个端口再关掉，保证该端口确实没人听
    const port = await listen(() => {})
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
    )
    await expect(dialThroughProxy(proxyAt(port), { host: 'h', port: 22 })).rejects.toThrow(
      /无法连接SOCKS5 代理 127\.0\.0\.1:\d+（代理未启动或端口不对）/
    )
  })
})
