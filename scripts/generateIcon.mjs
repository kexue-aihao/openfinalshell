/**
 * 生成应用图标 build/icon.png（512×512）。
 * 纯 Node 实现（zlib + 手写 PNG chunk），避免引入 canvas 之类的原生依赖。
 * 图形与界面里的 logo 一致：蓝→绿渐变圆角方块 + 终端提示符 >_
 *
 * 用法：node scripts/generateIcon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = join(root, 'build', 'icon.png')

/** 圆角方块的有向距离场：返回该点到形状边缘的距离（负数=形状内） */
function roundedRectSdf(x, y, halfW, halfH, radius) {
  const dx = Math.abs(x) - (halfW - radius)
  const dy = Math.abs(y) - (halfH - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/** 线段的 SDF，用来画提示符笔画 */
function segmentSdf(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const apx = px - ax
  const apy = py - ay
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)))
  return Math.hypot(apx - abx * t, apy - aby * t)
}

const lerp = (a, b, t) => a + (b - a) * t
/** 边缘 1px 抗锯齿 */
const coverage = (sdf) => Math.max(0, Math.min(1, 0.5 - sdf))

function pixel(x, y) {
  const cx = x - SIZE / 2 + 0.5
  const cy = y - SIZE / 2 + 0.5

  const bodyAlpha = coverage(roundedRectSdf(cx, cy, SIZE / 2 - 26, SIZE / 2 - 26, 112))
  if (bodyAlpha <= 0) return [0, 0, 0, 0]

  // 135° 渐变：#1677ff → #52c41a
  const t = Math.max(0, Math.min(1, (x + y) / (2 * SIZE)))
  let r = lerp(0x16, 0x52, t)
  let g = lerp(0x77, 0xc4, t)
  let b = lerp(0xff, 0x1a, t)

  // 提示符 ">"（两笔）与光标下划线 "_"
  const stroke = 26
  const chevron = Math.min(
    segmentSdf(cx, cy, -120, -72, -20, 8),
    segmentSdf(cx, cy, -20, 8, -120, 88)
  )
  const underscore = segmentSdf(cx, cy, 20, 88, 140, 88)
  const glyph = coverage(Math.min(chevron, underscore) - stroke / 2)
  if (glyph > 0) {
    r = lerp(r, 255, glyph)
    g = lerp(g, 255, glyph)
    b = lerp(b, 255, glyph)
  }

  return [Math.round(r), Math.round(g), Math.round(b), Math.round(bodyAlpha * 255)]
}

// ---- 逐行组装 RGBA 原始数据（每行前置 filter byte 0）----
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
let offset = 0
for (let y = 0; y < SIZE; y++) {
  raw[offset++] = 0
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixel(x, y)
    raw[offset++] = r
    raw[offset++] = g
    raw[offset++] = b
    raw[offset++] = a
  }
}

// ---- PNG 封装 ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, png)
console.log(`wrote ${outPath} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`)
