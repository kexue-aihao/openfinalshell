import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { scopedLogger } from '../utils/logger'

/**
 * 原生模块（Rust / napi-rs）的唯一加载点。
 *
 * 三条铁律：
 * 1. **整模块回退**：`.node` 缺失或加载失败时整个 lansync 走 TS，不存在「一半
 *    原生一半 TS」。`FrameReader` 是有状态的，中途换实现等于重放缓冲区。
 * 2. **回退只发生在实例创建时**：一旦用原生构造了 reader，后续 `feed` 抛错必须
 *    原样抛给调用方（连接随之销毁），不许偷偷换回 TS。
 * 3. **加载顺序固定**：`OFS_NATIVE_PATH` → 打包态 `resourcesPath/ofs-native` →
 *    开发态 `build/ofs-native/<platform>-<arch>`。任一失败只记一次日志。
 *
 * 这个文件刻意不 import `electron`：`app.isPackaged` 在测试桩里是 undefined，
 * 用它做分支会让测试与打包态走不同路径。只依赖 `process.resourcesPath` 是否存在。
 */

export interface NativeFrameReader {
  feed(chunk: Buffer): unknown[]
  setMaxBytes(maxBytes: number): void
}

export interface NativeLansync {
  lansyncEncodeDiscovery(msg: unknown): Buffer
  lansyncDecodeDiscovery(buf: Buffer): unknown
  lansyncEncodeFrame(frame: unknown): Buffer
  lansyncFrameReaderNew(maxBytes?: number): NativeFrameReader
  nativeVersion(): string
  nativeAbiLevel(): number
}

export type NativeBackend = 'ts' | 'rust' | 'auto'

export interface NativeStatus {
  /** 配置的期望后端 */
  backend: NativeBackend
  /** 实际生效的实现 */
  active: 'ts' | 'rust'
  /** 实际加载到的文件；未加载时为 null */
  path: string | null
  version: string | null
  /** 熔断或模块白名单关闭时记录原因，便于诊断 */
  reason: string | null
}

const log = scopedLogger('native')

const ADDON_FILE = 'ofs_napi.node'

let cached: NativeLansync | null | undefined
let cachedPath: string | null = null
let cachedReason: string | null = null

function truthyEnv(name: string): boolean {
  const value = process.env[name]
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'on' || value === 'ON'
}

function backendMode(): NativeBackend {
  const raw = (process.env['OFS_CORE_BACKEND'] ?? 'auto').trim().toLowerCase()
  if (raw === 'ts' || raw === 'rust' || raw === 'auto') return raw
  throw new Error(`OFS_CORE_BACKEND 只能是 ts / rust / auto，收到 ${raw}`)
}

/** `OFS_RUST_MODULES` 用逗号分隔；默认只开 lansync。 */
function moduleEnabled(module: 'lansync'): boolean {
  const raw = process.env['OFS_RUST_MODULES']
  if (raw === undefined || raw.trim() === '') return module === 'lansync'
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(module)
}

function platformKey(): string {
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function archKey(): string {
  if (process.arch === 'ia32') return 'ia32'
  if (process.arch === 'arm64') return 'arm64'
  return 'x64'
}

/** 开发态与打包态的候选路径。顺序即优先级。 */
export function nativeCandidates(): string[] {
  const candidates: string[] = []
  const override = process.env['OFS_NATIVE_PATH']
  if (override) candidates.push(override)
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (resources) candidates.push(join(resources, 'ofs-native', ADDON_FILE))
  const stageRoot = join(process.cwd(), 'build', 'ofs-native')
  // 平铺布局是打包脚本的产物；按架构分目录是本地手工构建时可能出现的形态。
  candidates.push(join(stageRoot, ADDON_FILE))
  candidates.push(join(stageRoot, `${platformKey()}-${archKey()}`, ADDON_FILE))
  return candidates
}

function looksLikeLansync(binding: unknown): binding is NativeLansync {
  if (typeof binding !== 'object' || binding === null) return false
  const candidate = binding as Record<string, unknown>
  return (
    typeof candidate['lansyncEncodeDiscovery'] === 'function' &&
    typeof candidate['lansyncDecodeDiscovery'] === 'function' &&
    typeof candidate['lansyncEncodeFrame'] === 'function' &&
    typeof candidate['lansyncFrameReaderNew'] === 'function'
  )
}

function load(): NativeLansync | null {
  if (cached !== undefined) return cached

  const mode = backendMode()
  if (truthyEnv('OFS_NATIVE_DISABLE')) {
    cached = null
    cachedReason = 'OFS_NATIVE_DISABLE=1'
    return cached
  }
  if (!moduleEnabled('lansync')) {
    cached = null
    cachedReason = 'OFS_RUST_MODULES 不含 lansync'
    return cached
  }
  if (mode === 'ts') {
    cached = null
    cachedReason = 'OFS_CORE_BACKEND=ts'
    return cached
  }

  // 刻意不用 `createRequire(import.meta.url)`：electron-vite 的 main 产物会因此
  // 注入 ESM/CJS 互操作 shim，把整块 chunk 搅成 esbuild 都读不下去的形态。
  // require 的 base 只影响**相对**解析，这里传的是绝对路径，所以用 execPath 即可。
  const requireAddon = createRequire(process.execPath)
  for (const candidate of nativeCandidates()) {
    if (!existsSync(candidate)) continue
    try {
      const binding = requireAddon(candidate) as unknown
      if (!looksLikeLansync(binding)) {
        log.warn(`[ofs] native binding shape mismatch: ${candidate}`)
        continue
      }
      cached = binding
      cachedPath = candidate
      log.info(`[ofs] native lansync loaded: ${candidate} (${binding.nativeVersion?.() ?? 'unknown'})`)
      return cached
    } catch (error) {
      log.warn(`[ofs] native load failed: ${candidate}: ${(error as Error).message}`)
    }
  }

  cached = null
  cachedReason = 'no loadable addon'
  if (mode === 'rust') {
    // CI 的 rust lane 靠这条失败：原生缺失必须是硬错误，而不是静默降级。
    throw new Error(
      `[ofs] OFS_CORE_BACKEND=rust 但原生模块不可用；已尝试：${nativeCandidates().join(', ')}`
    )
  }
  log.info('[ofs] native unavailable')
  return cached
}

/** 首次调用时解析并缓存；`rust` 模式下缺件会抛错。 */
export function nativeLansync(): NativeLansync | null {
  return load()
}

export function nativeStatus(): NativeStatus {
  const backend = backendMode()
  const binding = load()
  return {
    backend,
    active: binding ? 'rust' : 'ts',
    path: binding ? cachedPath : null,
    version: binding ? (binding.nativeVersion?.() ?? null) : null,
    reason: binding ? null : cachedReason
  }
}

/** 测试与诊断用：重置缓存（不用于生产路径）。 */
export function resetNativeCacheForTests(): void {
  cached = undefined
  cachedPath = null
  cachedReason = null
}

/** 原生侧的稳定错误码 → 现有中文消息。文案必须与 `protocol.ts` 一字不差。 */
export function mapNativeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('OFS_LANSYNC_FRAME_LEN_INVALID')) {
    const payload = message.split(':')[1]?.trim()
    const length = payload && /^\d+$/.test(payload) ? payload : '0'
    return new Error(`lansync: 帧长度不合法（${length}）`)
  }
  if (message.includes('OFS_LANSYNC_FRAME_JSON_INVALID')) {
    return new Error('lansync: 帧不是合法 JSON')
  }
  if (message.includes('OFS_LANSYNC_FRAME_SHAPE_INVALID')) {
    return new Error('lansync: 帧结构不合法')
  }
  return error instanceof Error ? error : new Error(message)
}

// 启动即解析：`OFS_CORE_BACKEND=rust` 时缺件必须在这里就炸掉（而不是等第一次同步
// 才报错，更不是被 `safeSend` 的 try/catch 吞掉）。`auto` / `ts` 下这只是一次
// existsSync，失败也只记一条日志。
load()
