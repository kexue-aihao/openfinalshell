#!/usr/bin/env node
/**
 * 生成 lansync 的跨语言金标。
 *
 * 输入：`shared-schema/fixtures/lansync-cases.json`（人工维护的用例清单）
 * 输出：`shared-schema/fixtures/lansync-golden.json`
 *
 * golden 是**唯一事实源**：TS 的差分测试与 Rust 的 `cargo test` 都只读这一份，
 * 任何一侧行为变化都会让另一侧红。所以这个脚本自己不实现协议 —— 它调
 * `src/main/lansync/protocol.ts` 的现役实现，把结果冻下来。
 *
 * 为什么用 vite 的 `ssrLoadModule` 而不是纯 node 跑 TS：`protocol.ts` 的
 * `FrameReader` 用了构造函数参数属性（`private readonly onFrame`），Node 的
 * 类型擦除不支持这种非可擦除语法。vite 本来就是本项目的构建器，零新增依赖。
 *
 * 用法：
 *   node scripts/generateLansyncGolden.mjs          # 写入 golden
 *   node scripts/generateLansyncGolden.mjs --check  # 只校验，不一致则退出码 1
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const casesPath = resolve(root, 'shared-schema', 'fixtures', 'lansync-cases.json')
const goldenPath = resolve(root, 'shared-schema', 'fixtures', 'lansync-golden.json')
const checkOnly = process.argv.includes('--check')

// 金标必须是**纯 TS 实现**的产物，否则就是原生跟原生对拍。必须在 ssrLoadModule
// 之前设置：`protocol.ts` → `core/native.ts` 在模块初始化时就会解析后端。
process.env.OFS_CORE_BACKEND = 'ts'

function withPrefix(body) {
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32BE(body.byteLength, 0)
  return Buffer.concat([head, body])
}

function classifyFrameError(message) {
  if (message.includes('帧长度不合法')) return 'len'
  if (message.includes('帧不是合法 JSON')) return 'json'
  if (message.includes('帧结构不合法')) return 'shape'
  return 'unknown'
}

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true }
})

let protocol
try {
  protocol = await server.ssrLoadModule('/src/main/lansync/protocol.ts')
} finally {
  // 只关 dev server，不动进程退出码。
  await server.close()
}

const { encodeDiscovery, decodeDiscovery, encodeFrame, FrameReader } = protocol

const spec = JSON.parse(await readFile(casesPath, 'utf8'))
const golden = {
  version: 1,
  protocol: 1,
  generatedBy: 'scripts/generateLansyncGolden.mjs',
  cases: []
}

for (const entry of spec.cases) {
  const expect = entry.expect ?? 'accept'
  if (entry.type === 'discovery') {
    const bytes = entry.hex
      ? Buffer.from(entry.hex, 'hex')
      : entry.spaces
        ? Buffer.from(' '.repeat(entry.spaces), 'utf8')
        : encodeDiscovery(entry.msg)
    const decoded = decodeDiscovery(bytes)
    if (expect === 'reject') {
      if (decoded !== null) throw new Error(`${entry.name}: 期望拒绝，但 TS 解码成功`)
      golden.cases.push({
        name: entry.name,
        type: 'discovery',
        hex: bytes.toString('hex'),
        decision: 'reject'
      })
      continue
    }
    if (decoded === null) throw new Error(`${entry.name}: 期望接受，但 TS 解码返回 null`)
    const reencoded = encodeDiscovery(decoded)
    const roundTrip = decodeDiscovery(reencoded)
    if (JSON.stringify(roundTrip) !== JSON.stringify(decoded)) {
      throw new Error(`${entry.name}: 解码 → 编码 → 解码不稳定`)
    }
    golden.cases.push({
      name: entry.name,
      type: 'discovery',
      hex: bytes.toString('hex'),
      decision: 'accept',
      ...(entry.msg !== undefined ? { input: entry.msg } : {}),
      decoded,
      reencodedHex: reencoded.toString('hex')
    })
    continue
  }

  const bytes = entry.hex
    ? Buffer.from(entry.hex, 'hex')
    : entry.rawText !== undefined
      ? withPrefix(Buffer.from(entry.rawText, 'utf8'))
      : entry.body !== undefined
        ? withPrefix(Buffer.from(JSON.stringify(entry.body), 'utf8'))
        : encodeFrame(entry.frame)

  const frames = []
  const reader = new FrameReader((frame) => frames.push(frame))
  let failure = null
  try {
    reader.feed(bytes)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }

  if (expect === 'reject') {
    if (failure === null) throw new Error(`${entry.name}: 期望拒绝，但 TS 解码成功`)
    const reason = classifyFrameError(failure)
    if (reason === 'unknown') throw new Error(`${entry.name}: 无法分类的错误：${failure}`)
    if (entry.reject && entry.reject !== reason) {
      throw new Error(`${entry.name}: 期望 ${entry.reject}，实际 ${reason}（${failure}）`)
    }
    golden.cases.push({
      name: entry.name,
      type: 'frame',
      hex: bytes.toString('hex'),
      decision: 'reject',
      reason
    })
    continue
  }

  if (failure !== null) throw new Error(`${entry.name}: 期望接受，但 TS 抛错：${failure}`)
  if (frames.length !== 1) throw new Error(`${entry.name}: 期望恰好 1 帧，实际 ${frames.length}`)
  const decoded = frames[0]
  const reencoded = encodeFrame(decoded)
  const verify = []
  new FrameReader((frame) => verify.push(frame)).feed(reencoded)
  if (JSON.stringify(verify[0]) !== JSON.stringify(decoded)) {
    throw new Error(`${entry.name}: 解码 → 编码 → 解码不稳定`)
  }
  golden.cases.push({
    name: entry.name,
    type: 'frame',
    hex: bytes.toString('hex'),
    decision: 'accept',
    ...(entry.frame !== undefined
      ? { input: entry.frame }
      : entry.body !== undefined
        ? { input: entry.body }
        : {}),
    decoded,
    reencodedHex: reencoded.toString('hex')
  })
}

const text = `${JSON.stringify(golden, null, 2)}\n`

if (checkOnly) {
  const current = await readFile(goldenPath, 'utf8').catch(() => null)
  if (current !== text) {
    console.error('lansync-golden.json 与当前 TS 实现不一致，请运行 node scripts/generateLansyncGolden.mjs 重新生成')
    process.exitCode = 1
  } else {
    console.log(`OK: ${golden.cases.length} 条 goldens 与 TS 实现一致`)
  }
} else {
  await writeFile(goldenPath, text, 'utf8')
  const accepted = golden.cases.filter((entry) => entry.decision === 'accept').length
  console.log(
    `Wrote ${golden.cases.length} goldens (${accepted} accept / ${golden.cases.length - accepted} reject) -> ${goldenPath}`
  )
}
