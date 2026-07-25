import log from 'electron-log/main'

/** 命中即整值替换，防止密钥进日志 */
const SENSITIVE_KEY = /password|passphrase|privatekey|secret|token/i
const MAX_DEPTH = 6

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[depth]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen))
  if (value instanceof Error) return value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[bytes ${value.byteLength}]`
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(v, depth + 1, seen)
  }
  return out
}

export function initLogger(): void {
  log.initialize()
  log.transports.file.level = 'info'
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info'
  log.hooks.push((message) => {
    message.data = message.data.map((d) => redactValue(d, 0, new WeakSet()))
    return message
  })
}

export const logger = log.scope('main')
export function scopedLogger(scope: string): ReturnType<typeof log.scope> {
  return log.scope(scope)
}
