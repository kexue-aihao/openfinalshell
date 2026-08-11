import { z } from 'zod'

/**
 * 局域网同步的线上协议 —— 纯函数编解码，零 I/O。
 *
 * 单独成文件的理由与 pathSync.ts 一样：这里的每个分支都该被单测钉死，而它们
 * 不需要 socket 就能跑真。socket 的生命周期归 discovery.ts / LanSyncManager.ts。
 *
 * 两层报文：
 * - **发现（UDP）**：JSON 明文，只有设备名/端口这类低敏元数据。任何解析失败一律
 *   静默丢弃返回 null —— 这个端口上收到什么都不奇怪（别的软件、扫描器、损坏包），
 *   丢弃是常态而不是异常。
 * - **传输（TCP）**：4 字节大端长度前缀 + UTF-8 JSON 帧。与 UDP 相反，帧不合法一律
 *   **抛错**：TCP 对端是自称要跟我们说话的人，说不成话就该断连，而不是装没看见。
 */

export const SYNC_PROTO = 1

/** UDP 发现端口。固定常量：两端必须一致才能互相发现（避开 LocalSend 的 53317） */
export const DISCOVERY_PORT = 52133

/** IPv4 本地管理域组播组（239.255.0.0/16 不出路由器） */
export const DISCOVERY_GROUP = '239.255.77.88'

/** 超过一个以太网 MTU 的发现报文直接丢弃 —— 我们自己的报文远小于此，长的必是垃圾 */
export const MAX_DATAGRAM_BYTES = 1400

/** 单帧上限，与 importData 的 MAX_IMPORT_BYTES 对齐（载荷就是同一份信封） */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

/**
 * 握手期（confirm 之前）的帧上限。hello/confirm-s 本就只有几百字节，用一个小得多的
 * 上限，未认证对端就无法声称并让我们缓冲一个接近 64MiB 的帧。confirm 成功后再经
 * `setMaxBytes` 升到 MAX_FRAME_BYTES 收 payload。
 */
export const HANDSHAKE_MAX_FRAME_BYTES = 64 * 1024

const MAGIC = 'OFSSYNC1'

// ---------------------------------------------------------------------------
// 发现报文（UDP）
// ---------------------------------------------------------------------------

const probeSchema = z.object({
  magic: z.literal(MAGIC),
  proto: z.literal(SYNC_PROTO),
  kind: z.literal('probe'),
  deviceId: z.string().min(1).max(64),
  deviceName: z.string().max(128)
})

const announceSchema = z.object({
  magic: z.literal(MAGIC),
  proto: z.literal(SYNC_PROTO),
  kind: z.literal('announce'),
  deviceId: z.string().min(1).max(64),
  deviceName: z.string().max(128),
  appVersion: z.string().max(32),
  tcpPort: z.number().int().min(1).max(65535),
  sessionId: z.string().min(1).max(64)
})

export type DiscoveryProbe = z.infer<typeof probeSchema>
export type DiscoveryAnnounce = z.infer<typeof announceSchema>
export type DiscoveryMsg = DiscoveryProbe | DiscoveryAnnounce

export function encodeDiscovery(msg: DiscoveryMsg): Buffer {
  return Buffer.from(JSON.stringify(msg), 'utf8')
}

/** 解不出、魔数/版本不符、超长 → null（静默丢弃，理由见文件头） */
export function decodeDiscovery(buf: Buffer): DiscoveryMsg | null {
  if (buf.byteLength > MAX_DATAGRAM_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
  const kind = (parsed as { kind?: unknown })?.kind
  const result =
    kind === 'probe'
      ? probeSchema.safeParse(parsed)
      : kind === 'announce'
        ? announceSchema.safeParse(parsed)
        : null
  return result?.success ? result.data : null
}

// ---------------------------------------------------------------------------
// 传输帧（TCP）
// ---------------------------------------------------------------------------

/** 公钥 SPKI DER 的 base64（x25519 固定 44 字节 → 60 字符），给点余量卡 128 */
const pubKey = z.string().min(1).max(128)

const frameSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hello'),
    magic: z.literal(MAGIC),
    proto: z.literal(SYNC_PROTO),
    deviceId: z.string().min(1).max(64),
    deviceName: z.string().max(128),
    appVersion: z.string().max(32),
    senderPub: pubKey
  }),
  z.object({
    kind: z.literal('hello-ack'),
    deviceId: z.string().min(1).max(64),
    deviceName: z.string().max(128),
    appVersion: z.string().max(32),
    receiverPub: pubKey,
    /** 16 字节随机盐的 base64，接收端出（配对密钥派生的会话成分之一） */
    salt: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(64)
  }),
  /** 发送端的码证明：HMAC(pairKey, 'sender' ‖ transcript) 的 base64 */
  z.object({ kind: z.literal('confirm-s'), mac: z.string().min(1).max(128) }),
  /** 接收端的码证明（互证的另一半，发送端验过才发 payload） */
  z.object({ kind: z.literal('confirm-r'), mac: z.string().min(1).max(128) }),
  /** 标准 v2 导出信封的 JSON 原文（seal 口令 = 配对派生密钥，见 pairing.channelPass） */
  z.object({ kind: z.literal('payload'), envelope: z.string().min(1) }),
  z.object({ kind: z.literal('received') }),
  z.object({
    kind: z.literal('applied'),
    profiles: z.number().int().min(0),
    snippets: z.number().int().min(0),
    forwards: z.number().int().min(0),
    knownHosts: z.number().int().min(0),
    secrets: z.number().int().min(0),
    skipped: z.number().int().min(0)
  }),
  z.object({ kind: z.literal('rejected') }),
  /**
   * code 是 i18n 键（err.sync.* / err.net.*）：两端是同一个应用，各自本地渲染，
   * 于是错误提示天然跟随各端自己的界面语言。收到不认识的键回退 err.sync.remoteError。
   */
  z.object({
    kind: z.literal('error'),
    code: z.string().min(1).max(64),
    params: z.record(z.string().max(32), z.union([z.string().max(256), z.number()])).optional()
  })
])

export type SyncFrame = z.infer<typeof frameSchema>

export function encodeFrame(frame: SyncFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32BE(body.byteLength, 0)
  return Buffer.concat([head, body])
}

/**
 * 增量拆帧器。TCP 是字节流：一帧可能分多个 chunk 到达，一个 chunk 也可能带多帧，
 * 这个类把两种情况都归一成"每完整一帧回调一次"。
 *
 * 三种抛错（坏长度、坏 JSON、结构不合法）都留给调用方 catch 后**销毁连接** ——
 * 帧边界一旦不可信，这条流上后面的每个字节都不可信，没有"跳过这帧继续"的选项。
 * 长度检查在**读到前缀的那一刻**做，而不是等字节攒够：恶意前缀声称 100MiB 时，
 * 等待就是攻击本身（内存被 chunks 一路填满）。
 */
export class FrameReader {
  private chunks: Buffer[] = []
  private buffered = 0

  constructor(
    private readonly onFrame: (frame: SyncFrame) => void,
    private maxBytes = MAX_FRAME_BYTES
  ) {}

  /** 调高帧上限（握手小上限 → confirm 成功后升到 payload 的 64MiB） */
  setMaxBytes(n: number): void {
    this.maxBytes = n
  }

  feed(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.buffered += chunk.byteLength
    while (this.buffered >= 4) {
      const head = this.peek(4)
      const bodyLen = head.readUInt32BE(0)
      if (bodyLen === 0 || bodyLen > this.maxBytes) {
        throw new Error(`lansync: 帧长度不合法（${bodyLen}）`)
      }
      if (this.buffered < 4 + bodyLen) return
      const whole = this.take(4 + bodyLen)
      let parsed: unknown
      try {
        parsed = JSON.parse(whole.subarray(4).toString('utf8'))
      } catch {
        throw new Error('lansync: 帧不是合法 JSON')
      }
      const result = frameSchema.safeParse(parsed)
      if (!result.success) throw new Error('lansync: 帧结构不合法')
      this.onFrame(result.data)
    }
  }

  /** 只看不取（长度前缀可能跨 chunk，先并一次） */
  private peek(n: number): Buffer {
    if (this.chunks[0].byteLength >= n) return this.chunks[0]
    this.chunks = [Buffer.concat(this.chunks)]
    return this.chunks[0]
  }

  private take(n: number): Buffer {
    const merged = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
    this.chunks = merged.byteLength > n ? [merged.subarray(n)] : []
    this.buffered -= n
    return merged.subarray(0, n)
  }
}
