import { createHash } from 'node:crypto'

/** 纯函数：无 electron 依赖，可单测 */

/** 从 ssh2 hostVerifier 收到的原始 key blob 里解析算法名（首个 length-prefixed 字段） */
export function parseKeyType(key: Buffer): string {
  try {
    if (key.length < 4) return 'unknown'
    const len = key.readUInt32BE(0)
    if (len <= 0 || len > 64 || key.length < 4 + len) return 'unknown'
    return key.subarray(4, 4 + len).toString('ascii')
  } catch {
    return 'unknown'
  }
}

/** OpenSSH 风格的 SHA256 指纹（base64，去尾部 '='） */
export function fingerprintSha256(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}
