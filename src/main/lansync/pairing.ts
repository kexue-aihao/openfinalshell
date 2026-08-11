import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomInt,
  scrypt,
  timingSafeEqual,
  type KeyObject
} from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

/**
 * 局域网同步的配对密码学 —— 全部 node:crypto 内置（X25519/HKDF/scrypt/HMAC），
 * 零新依赖。纯函数，socket 生命周期归 LanSyncManager。
 *
 * 设计的一句话版本：**6 位配对码只做认证，不做加密密钥**。
 *
 * - 双方各出一对 X25519 临时密钥，先做 ECDH 得到共享秘密；
 * - 配对密钥 pairKey = scrypt(码, HKDF(共享秘密, salt, transcript))。
 *   scrypt 的盐里**折进了 ECDH 秘密** —— 被动嗅探者抓全流量也没有共享秘密，
 *   连离线暴力猜码的起点都没有；
 * - transcript 把双方公钥 + salt + sessionId 全部绑死：中间人两条腿上的 transcript
 *   必然不同，转发对方的码证明一定验不过 —— 想伪造就得在帧超时内从 scrypt 证明里
 *   暴力出码（10^6 次 × ~100ms，约 28 核·小时），做不到；
 * - 每会话等于**一次**在线猜测（错一次调用方立即烧码换新码），成功率 10^-6。
 *
 * 码证明必须过 scrypt 而不是裸 HMAC —— 这不是仪式：恶意"接收端"拿到发送端的
 * confirm-s 后可以离线枚举码，scrypt 把单次尝试的成本钉在 ~100ms，让 10 分钟
 * 会话窗内的离线枚举也不可行（护栏测试盯着这一条，别"优化"掉）。
 */

/** 与导出侧同一档：~100ms/次，是在线与离线暴力的成本地板 */
const SCRYPT_N = 32768
const SCRYPT_MAXMEM = 64 * 1024 * 1024

const HKDF_INFO_PREFIX = 'ofs-lansync-v1'

/** 6 位数字配对码（crypto.randomInt 是拒绝采样，无模偏差）。升 8 位改这里即可 */
export function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** 一次会话一对，用完即弃。公钥以 SPKI DER 上线（base64 由调用方转） */
export function createEcdhPair(): { publicDer: Buffer; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { publicDer: publicKey.export({ type: 'spki', format: 'der' }), privateKey }
}

/**
 * 会话转录：双方公钥 + salt + sessionId 的 sha256。
 * 每个成分带 4 字节长度前缀再喂 —— 裸拼接在成分边界上有歧义（a‖bc 与 ab‖c 同哈希），
 * 长度框定让"任一成分变了"必然改变哈希。
 */
export function computeTranscript(
  senderPubDer: Buffer,
  receiverPubDer: Buffer,
  salt: Buffer,
  sessionId: string
): Buffer {
  const hash = createHash('sha256')
  for (const part of [senderPubDer, receiverPubDer, salt, Buffer.from(sessionId, 'utf8')]) {
    const len = Buffer.allocUnsafe(4)
    len.writeUInt32BE(part.byteLength, 0)
    hash.update(len)
    hash.update(part)
  }
  return hash.digest()
}

/**
 * 从（自己的私钥 + 对方公钥 + 码 + salt + transcript）派生 32 字节配对密钥。
 * 两侧各自计算，结果必须一致 —— 单测钉这一条。
 *
 * **异步**：scrypt 走 libuv 线程池而不是同步阻塞。这一条是安全关键——它跑在
 * 收到未认证 hello 帧的路径上（pairKey 早于任何码/MAC 校验），同步版会让局域网
 * 对端用重复 hello 把 Electron 主进程的事件循环连续占满（界面 + 所有 SSH 会话冻结）。
 * 配合调用方的"每连接只处理首个 hello"幂等守卫，未认证对端至多触发一次线程池 scrypt。
 *
 * 对方公钥来自网络，什么都可能是：不是 x25519（拿 RSA 公钥骗 diffieHellman）
 * 直接抛错，调用方按协议错误断连。
 */
export async function derivePairKey(args: {
  ownPrivate: KeyObject
  peerPublicDer: Buffer
  code: string
  salt: Buffer
  transcript: Buffer
}): Promise<Buffer> {
  const peerPublic = createPublicKey({ key: args.peerPublicDer, format: 'der', type: 'spki' })
  if (peerPublic.asymmetricKeyType !== 'x25519') {
    throw new Error('lansync: 对方公钥不是 x25519')
  }
  const shared = diffieHellman({ privateKey: args.ownPrivate, publicKey: peerPublic })
  const info = Buffer.concat([Buffer.from(HKDF_INFO_PREFIX, 'utf8'), args.transcript])
  const kdfSalt = Buffer.from(hkdfSync('sha256', shared, args.salt, info, 32))
  return scryptAsync(args.code, kdfSalt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: SCRYPT_MAXMEM })
}

/**
 * 码证明。role 掺进去让两个方向的 MAC 不同 —— 否则接收端可以把发送端刚发来的
 * confirm-s 原样回射充当 confirm-r，等于单向证明。
 */
export function confirmMac(pairKey: Buffer, role: 'sender' | 'receiver', transcript: Buffer): Buffer {
  return createHmac('sha256', pairKey).update(role).update(transcript).digest()
}

/** timingSafeEqual 要求等长，先比长度（长度本身不是秘密） */
export function macEquals(a: Buffer, b: Buffer): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/**
 * 配对密钥 → sealString 的口令。43 字符 base64url（~256 bit 熵），
 * 让线上信封与文件导出**同构**：接收端走的就是既有的导入解密路径，
 * sealString 内部再跑一次 scrypt 对随机口令是冗余但无害（~100ms，一次一发）。
 */
export function channelPass(pairKey: Buffer): string {
  return pairKey.toString('base64url')
}
