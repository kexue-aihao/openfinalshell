import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { safeStorage } from 'electron'
import { metaGet, metaSet } from './Database'
import { t } from '../services/i18n'
import { scopedLogger } from '../utils/logger'
import { secureStorageAvailable } from './secureStorage'

const log = scopedLogger('crypto')

/**
 * 配置数据的**静态加密（at-rest）**。
 *
 * 一把主数据密钥（MDK，32 字节随机）用 `safeStorage`（Windows=DPAPI，绑定当前系统账户）
 * 加密后存进 meta 表——OS 账户绑定就体现在这一步。列加密本身用 `node:crypto`（无 native 依赖），
 * 比"每行调一次 DPAPI"快，且能派生一把决定论子钥给等值查找列用。
 *
 * 三个对外原语：
 * - `encField/decField`：不透明载荷/标签列，非决定论 AES-256-GCM（每值随机 IV）。
 * - `tokenize`：等值查找/去重列的决定论 token（HMAC-SHA256），保住 WHERE=/ON CONFLICT/NOT IN。
 *
 * 存储格式：`enc:1:` + base64(`iv(12) | tag(16) | ciphertext`)。`decField` 只对带前缀的值
 * 解密，其余**原样透传**——这一条让读路径同时容忍明文行与密文行，是迁移幂等/崩溃可重跑/
 * 降级安全的关键。
 *
 * 降级：`safeStorage` 不可用（少数环境）→ 无 MDK → `encField/tokenize` 原样返回、
 * `decField` 透传 → 整体退化为明文行为，不 brick。
 * 换机/换账户后 MDK 无法解出（key 丢失）→ 已加密的值无法解密，`decField` 抛错，
 * 由列表类读取逐行跳过；这是 OS 绑定加密的固有代价，迁移路径是"加密导出→新机导入"。
 */

const FIELD_PREFIX = 'enc:1:'
const MDK_META_KEY = 'data_key_v1'
export const DATA_ENCRYPTION_DIRTY_META_KEY = 'rows_need_encryption_v1'

let encKey: Buffer | null = null
let macKey: Buffer | null = null
let loggedKeyLoss = false
let loggedDirtyMarkFailure = false

/** 记录本次降级可能写出了明文，让下次安全后端恢复后重新扫描迁移。 */
function markDataEncryptionDirty(): void {
  try {
    metaSet(DATA_ENCRYPTION_DIRTY_META_KEY, '1')
  } catch (err) {
    // 明文降级本身不能因为辅助标记失败而 brick；真正的业务写入仍会报告其数据库错误。
    if (!loggedDirtyMarkFailure) {
      log.warn('failed to mark plaintext fallback for later encryption', err)
      loggedDirtyMarkFailure = true
    }
  }
}

function deriveKeys(key: Buffer): void {
  encKey = createHmac('sha256', key).update('ofs-enc-v1').digest()
  macKey = createHmac('sha256', key).update('ofs-lookup-v1').digest()
}

/** 载入已有 MDK，或首次生成并落库。返回 null 表示当前不可用（safeStorage 未就绪/缺失/key 丢失） */
function loadOrCreateKey(): Buffer | null {
  // safeStorage 必须在 app ready 之后才可用（ready 前 isEncryptionAvailable 可能为 false）。
  // 此时返回 null、且 keys() 不缓存它——否则启动早期（app ready 前）的一次读取
  // 会把整个会话的加密永久关掉。
  if (!secureStorageAvailable()) return null
  const stored = metaGet(MDK_META_KEY)
  if (stored) {
    try {
      const inner = safeStorage.decryptString(Buffer.from(stored, 'base64'))
      return Buffer.from(inner, 'base64')
    } catch (err) {
      // 换机/换账户：DPAPI 解不开。**绝不能重新生成**——那会把已有密文变成永久孤儿。
      // 只记一次日志：keys() 不缓存 null，会反复走到这里。
      if (!loggedKeyLoss) {
        log.error('data key undecryptable (machine/account changed?); encrypted rows unreadable', err)
        loggedKeyLoss = true
      }
      return null
    }
  }
  const key = randomBytes(32)
  const wrapped = safeStorage.encryptString(key.toString('base64'))
  metaSet(MDK_META_KEY, wrapped.toString('base64'))
  return key
}

/**
 * 惰性解析 MDK 并派生子钥；返回 null 表示当前不可用。
 * **只缓存成功解析出的子钥、不缓存 null**——这样 app ready 前的过早调用（如启动时读 settings
 * 决定是否禁用 GPU）不会把整会话的加密永久关掉；ready 后再调即可解析成功、自愈。
 */
function keys(): { enc: Buffer; mac: Buffer } | null {
  if (encKey && macKey) return { enc: encKey, mac: macKey }
  const key = loadOrCreateKey()
  if (!key) return null
  deriveKeys(key)
  return { enc: encKey!, mac: macKey! }
}

/** 仅测试用：清掉进程内缓存，让下一次调用重新从库里解析 MDK */
export function _resetDataKeyCacheForTests(): void {
  encKey = null
  macKey = null
  loggedKeyLoss = false
  loggedDirtyMarkFailure = false
}

/** 当前环境是否能加密新写入（safeStorage 可用且 MDK 可解出） */
export function isDataEncryptionAvailable(): boolean {
  return keys() !== null
}

/** 值是否为本模块产出的密文 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(FIELD_PREFIX)
}

/** 加密一个字段值；加密不可用时原样返回明文 */
export function encField(plaintext: string): string {
  const k = keys()
  if (!k) {
    markDataEncryptionDirty()
    return plaintext
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k.enc, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return FIELD_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
}

/** 解密一个字段值；非本模块密文的值原样透传（明文/降级/部分迁移都安全） */
export function decField(stored: string): string {
  if (!stored.startsWith(FIELD_PREFIX)) return stored
  const k = keys()
  if (!k) throw new Error(t('err.data.dataKeyUnavailable'))
  const raw = Buffer.from(stored.slice(FIELD_PREFIX.length), 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const ct = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', k.enc, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/**
 * 等值查找/去重列的决定论 token（HMAC-SHA256 的 hex）。
 * 加密不可用时返回明文本身，等值语义照样成立（降级为今天的明文行为）。
 */
export function tokenize(plaintext: string): string {
  const k = keys()
  if (!k) {
    markDataEncryptionDirty()
    return plaintext
  }
  return createHmac('sha256', k.mac).update(plaintext, 'utf8').digest('hex')
}

/**
 * 列表读取专用：解密一个字段，解不开（换机/换账户 key 丢失）时返回 null，
 * 让调用方**逐行跳过**而不是让整张列表读取抛错、把界面整块打不开。
 */
export function tryDecField(stored: string): string | null {
  try {
    return decField(stored)
  } catch {
    return null
  }
}

/** 同 tryDecField，但顺带 JSON.parse；解不开或解析失败返回 null */
export function tryDecJson<T>(stored: string): T | null {
  try {
    return JSON.parse(decField(stored)) as T
  } catch {
    return null
  }
}
