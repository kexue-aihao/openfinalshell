import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 后端开关的语义（计划书 §4.4 里那条「三态行为符合规格」）。
 *
 * 这里测的不是编解码，而是**回退边界**：
 * - `auto` 有原生就用原生，没有就整模块回退；
 * - `ts` 永远不用原生（哪怕文件就在那儿）；
 * - `rust` 缺件必须**抛错**（CI 的 rust lane 靠这条失败，而不是静默降级）；
 * - `OFS_NATIVE_DISABLE=1` 是最高优先级熔断。
 */

const ENV_KEYS = ['OFS_CORE_BACKEND', 'OFS_NATIVE_DISABLE', 'OFS_NATIVE_PATH', 'OFS_RUST_MODULES']

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

const stageRoot = join(process.cwd(), 'build', 'ofs-native')
const addonPath = existsSync(join(stageRoot, 'ofs_napi.node'))
  ? join(stageRoot, 'ofs_napi.node')
  : join(stageRoot, `${platformKey()}-${archKey()}`, 'ofs_napi.node')
const addonAvailable = existsSync(addonPath)

const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key])
  for (const key of ENV_KEYS) delete process.env[key]
  vi.resetModules()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

async function load() {
  return import('../../src/main/core/native')
}

describe('后端开关', () => {
  it('OFS_CORE_BACKEND=ts 永远不用原生', async () => {
    process.env['OFS_CORE_BACKEND'] = 'ts'
    const native = await load()
    expect(native.nativeLansync()).toBeNull()
    expect(native.nativeStatus().active).toBe('ts')
  })

  it('OFS_NATIVE_DISABLE=1 是最高优先级熔断', async () => {
    process.env['OFS_NATIVE_DISABLE'] = '1'
    const native = await load()
    expect(native.nativeLansync()).toBeNull()
    expect(native.nativeStatus().reason).toBe('OFS_NATIVE_DISABLE=1')
  })

  it('OFS_RUST_MODULES 不含 lansync 时回退', async () => {
    process.env['OFS_RUST_MODULES'] = 'sftp,store'
    const native = await load()
    expect(native.nativeLansync()).toBeNull()
    expect(native.nativeStatus().reason).toContain('OFS_RUST_MODULES')
  })

  it('非法 OFS_CORE_BACKEND 直接报错，不静默当 auto', async () => {
    process.env['OFS_CORE_BACKEND'] = 'rsut'
    await expect(load()).rejects.toThrow(/OFS_CORE_BACKEND/)
  })

  it('OFS_CORE_BACKEND=rust 且缺件 → 导入即抛错', async () => {
    const original = process.cwd()
    // 换到一个没有 build/ofs-native 的目录，否则「开发态候选」会命中真产物。
    process.chdir(tmpdir())
    try {
      process.env['OFS_CORE_BACKEND'] = 'rust'
      process.env['OFS_NATIVE_PATH'] = join(original, 'build', 'ofs-native', 'definitely-missing.node')
      await expect(load()).rejects.toThrow(/OFS_CORE_BACKEND=rust/)
    } finally {
      process.chdir(original)
    }
  })

  it.skipIf(!addonAvailable)('auto 模式加载已构建的原生模块', async () => {
    const native = await load()
    expect(native.nativeStatus().active).toBe('rust')
    expect(native.nativeStatus().version).toMatch(/^0\.1\.0\//)
  })

  it.skipIf(!addonAvailable)('原生错误码映射回既有中文文案', async () => {
    const native = await load()
    expect(native.mapNativeError(new Error('OFS_LANSYNC_FRAME_LEN_INVALID:67108865')).message).toBe(
      'lansync: 帧长度不合法（67108865）'
    )
    expect(native.mapNativeError(new Error('OFS_LANSYNC_FRAME_JSON_INVALID')).message).toBe(
      'lansync: 帧不是合法 JSON'
    )
    expect(native.mapNativeError(new Error('OFS_LANSYNC_FRAME_SHAPE_INVALID')).message).toBe(
      'lansync: 帧结构不合法'
    )
  })
})
