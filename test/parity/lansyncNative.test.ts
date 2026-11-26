import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * L2 差分：TS 实现 vs Rust 原生模块，逐字节。
 *
 * 三组输入：
 * 1. 金标（`shared-schema/fixtures/lansync-golden.json`）—— 两个实现都必须与它一致；
 * 2. 边界用例（数字格式、转义、整数形键、默认值）—— 手写在下面的表里；
 * 3. 10,000 例种子化随机帧 —— 覆盖面靠随机，可复现靠固定种子。
 *
 * 原生模块缺失时整组 skip（开发机没装 Rust 工具链也不该让 `npm test` 红）。
 * 需要原生 lane 时先跑 `npm run build:native-addon`，或设置 `OFS_NATIVE_PATH`。
 */

interface NativeFrameReaderHandle {
  feed(chunk: Buffer): unknown[]
  setMaxBytes(maxBytes: number): void
}

interface NativeBinding {
  lansyncEncodeDiscovery(msg: unknown): Buffer
  lansyncDecodeDiscovery(buf: Buffer): unknown
  lansyncEncodeFrame(frame: unknown): Buffer
  lansyncFrameReaderNew(maxBytes?: number): NativeFrameReaderHandle
  nativeVersion(): string
}

type ProtocolModule = typeof import('../../src/main/lansync/protocol')

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

function addonPath(): string {
  const override = process.env['OFS_NATIVE_PATH']
  if (override) return override
  return join(process.cwd(), 'build', 'ofs-native', `${platformKey()}-${archKey()}`, 'ofs_napi.node')
}

const addon = addonPath()
const available = existsSync(addon)

let protocol: ProtocolModule
let native: NativeBinding | null = null

beforeAll(async () => {
  // 这个文件里 protocol.ts 必须是**纯 TS 实现**，否则就成了原生跟原生比。
  process.env['OFS_CORE_BACKEND'] = 'ts'
  protocol = await import('../../src/main/lansync/protocol')
  if (available) {
    const require = createRequire(import.meta.url)
    native = require(addon) as NativeBinding
  }
})

function decodeWithTs(bytes: Buffer): { ok: true; frames: unknown[] } | { ok: false; message: string } {
  const frames: unknown[] = []
  try {
    new protocol.FrameReader((frame) => frames.push(frame)).feed(bytes)
    return { ok: true, frames }
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}

function decodeWithNative(
  reader: NativeFrameReaderHandle,
  bytes: Buffer
): { ok: true; frames: unknown[] } | { ok: false; message: string } {
  try {
    return { ok: true, frames: reader.feed(bytes) }
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}

const REASON_MARKER: Record<string, string> = {
  len: 'OFS_LANSYNC_FRAME_LEN_INVALID',
  json: 'OFS_LANSYNC_FRAME_JSON_INVALID',
  shape: 'OFS_LANSYNC_FRAME_SHAPE_INVALID'
}

describe.skipIf(!available)('lansync 金标差分（TS vs Rust）', () => {
  it('每一条 golden 都与原生实现一致', () => {
    const golden = JSON.parse(
      readFileSync(resolve(process.cwd(), 'shared-schema', 'fixtures', 'lansync-golden.json'), 'utf8')
    ) as {
      cases: Array<{
        name: string
        type: 'frame' | 'discovery'
        hex: string
        decision: 'accept' | 'reject'
        reason?: string
        decoded?: unknown
        reencodedHex?: string
        input?: unknown
      }>
    }

    expect(golden.cases.length).toBeGreaterThan(40)

    for (const entry of golden.cases) {
      const bytes = Buffer.from(entry.hex, 'hex')
      if (entry.type === 'discovery') {
        const decoded = native!.lansyncDecodeDiscovery(bytes)
        if (entry.decision === 'reject') {
          expect(decoded, `${entry.name}: 原生应拒绝`).toBeNull()
          continue
        }
        expect(JSON.stringify(decoded), `${entry.name}: 解码不一致`).toBe(JSON.stringify(entry.decoded))
        expect(
          native!.lansyncEncodeDiscovery(entry.decoded).toString('hex'),
          `${entry.name}: 解码 → 编码不一致`
        ).toBe(entry.reencodedHex)
        if (entry.input !== undefined) {
          expect(native!.lansyncEncodeDiscovery(entry.input).toString('hex'), `${entry.name}: 原样编码不一致`).toBe(
            entry.hex
          )
        }
        continue
      }

      const reader = native!.lansyncFrameReaderNew()
      const outcome = decodeWithNative(reader, bytes)
      if (entry.decision === 'reject') {
        expect(outcome.ok, `${entry.name}: 原生应拒绝`).toBe(false)
        if (!outcome.ok) {
          const marker = REASON_MARKER[entry.reason ?? '']
          expect(marker, `${entry.name}: 未知 reason`).toBeTruthy()
          expect(outcome.message, `${entry.name}: 拒绝原因不一致`).toContain(marker)
        }
        continue
      }
      expect(outcome.ok, `${entry.name}: 原生应接受`).toBe(true)
      if (!outcome.ok) continue
      expect(outcome.frames.length, `${entry.name}: 帧数`).toBe(1)
      expect(JSON.stringify(outcome.frames[0]), `${entry.name}: 解码不一致`).toBe(JSON.stringify(entry.decoded))
      expect(
        native!.lansyncEncodeFrame(entry.decoded).toString('hex'),
        `${entry.name}: 解码 → 编码不一致`
      ).toBe(entry.reencodedHex)
      if (entry.input !== undefined) {
        expect(native!.lansyncEncodeFrame(entry.input).toString('hex'), `${entry.name}: 原样编码不一致`).toBe(
          entry.hex
        )
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 10,000 例随机帧
// ---------------------------------------------------------------------------

function xorshift(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

type Rng = () => number

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length) % values.length]
}

function randomInt(rng: Rng, max: number): number {
  return Math.floor(rng() * (max + 1))
}

const TEXT_ALPHABET = [
  'a',
  'Z',
  '0',
  ' ',
  '-',
  '_',
  'é',
  '中',
  '文',
  '😀',
  '"',
  '\\',
  '\n',
  '\t',
  '\u0001',
  '\u007f',
  '\u2028',
  '{',
  '}',
  ':'
]

/** 按 UTF-16 code unit 计长，与 zod 的 `.max()` 同一套度量。 */
function randomText(rng: Rng, maxUnits: number, minUnits = 0): string {
  const target = minUnits + randomInt(rng, Math.max(0, maxUnits - minUnits))
  let out = ''
  let units = 0
  while (units < target) {
    const char = pick(rng, TEXT_ALPHABET)
    const width = char.length
    if (units + width > maxUnits) break
    out += char
    units += width
  }
  if (out.length < minUnits) out = `${out}${'a'.repeat(minUnits - out.length)}`
  return out
}

const COUNTS = [0, 1, 2, 9, 42, 1e6, 1e20, 1e21, Number.MAX_SAFE_INTEGER, -0] as const
const PARAM_NUMBERS = [0, 1, -1, 0.5, 0.1 + 0.2, 1e-7, 1e21, 1e20, Number.MAX_SAFE_INTEGER, -0] as const
const PARAM_KEYS = ['a', 'b', 'name', '1', '2', '10', 'deviceName', '中文', '😀😀'] as const

function randomFrame(rng: Rng): unknown {
  switch (randomInt(rng, 8)) {
    case 0:
      return {
        kind: 'hello',
        magic: 'OFSSYNC1',
        proto: 1,
        deviceId: randomText(rng, 64, 1),
        deviceName: randomText(rng, 128),
        appVersion: randomText(rng, 32),
        senderPub: randomText(rng, 128, 1)
      }
    case 1:
      return {
        kind: 'hello-ack',
        deviceId: randomText(rng, 64, 1),
        deviceName: randomText(rng, 128),
        appVersion: randomText(rng, 32),
        receiverPub: randomText(rng, 128, 1),
        salt: randomText(rng, 64, 1),
        sessionId: randomText(rng, 64, 1)
      }
    case 2:
      return { kind: 'confirm-s', mac: randomText(rng, 128, 1) }
    case 3:
      return { kind: 'confirm-r', mac: randomText(rng, 128, 1) }
    case 4:
      return { kind: 'payload', envelope: randomText(rng, 400, 1) }
    case 5:
      return rng() < 0.5 ? { kind: 'received' } : { kind: 'rejected' }
    case 6: {
      const params: Record<string, string | number> = {}
      for (let index = 0; index < randomInt(rng, 4); index++) {
        const key = pick(rng, PARAM_KEYS)
        params[key] = rng() < 0.5 ? randomText(rng, 256) : pick(rng, PARAM_NUMBERS)
      }
      return {
        kind: 'error',
        code: randomText(rng, 64, 1) || 'err.sync.remoteError',
        ...(rng() < 0.75 ? { params } : {})
      }
    }
    default:
      return {
        kind: 'applied',
        profiles: pick(rng, COUNTS),
        groups: pick(rng, COUNTS),
        proxies: pick(rng, COUNTS),
        privateKeys: pick(rng, COUNTS),
        aiProfiles: pick(rng, COUNTS),
        snippets: pick(rng, COUNTS),
        forwards: pick(rng, COUNTS),
        knownHosts: pick(rng, COUNTS),
        secrets: pick(rng, COUNTS),
        skipped: pick(rng, COUNTS)
      }
  }
}

describe.skipIf(!available)('lansync 随机帧差分（10,000 例）', () => {
  it(
    '编码逐字节一致，解码结果与错误分类一致',
    () => {
      const rng = xorshift(0x5eed_1a45)
      let failures = 0
      const problems: string[] = []

      for (let index = 0; index < 10_000; index++) {
        const frame = randomFrame(rng)
        const tsBytes = protocol.encodeFrame(frame as never)
        const nativeBytes = native!.lansyncEncodeFrame(frame)

        if (!nativeBytes.equals(tsBytes)) {
          failures++
          if (problems.length < 5) {
            problems.push(
              `#${index} encode\n  ts:  ${tsBytes.toString('hex')}\n  rust:${nativeBytes.toString('hex')}\n  frame:${JSON.stringify(frame)}`
            )
          }
          continue
        }

        const tsResult = decodeWithTs(tsBytes)
        const nativeResult = decodeWithNative(native!.lansyncFrameReaderNew(), nativeBytes)
        if (tsResult.ok !== nativeResult.ok) {
          failures++
          if (problems.length < 5) {
            problems.push(`#${index} decision ts=${tsResult.ok} rust=${nativeResult.ok} frame=${JSON.stringify(frame)}`)
          }
          continue
        }
        if (tsResult.ok && nativeResult.ok) {
          const left = JSON.stringify(tsResult.frames)
          const right = JSON.stringify(nativeResult.frames)
          if (left !== right) {
            failures++
            if (problems.length < 5) problems.push(`#${index} decode\n  ts:  ${left}\n  rust:${right}`)
          }
        }
      }

      expect(problems.join('\n\n'), `共 ${failures} 例不一致`).toBe('')
      expect(failures).toBe(0)
    },
    180_000
  )
})
