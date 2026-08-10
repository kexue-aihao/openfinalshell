/**
 * 校验 i18n key 覆盖（N 语言版）：
 *   1. 代码里 `t('a.b')`（渲染 + 主进程）用到的 key 是否都在基准语言里定义；
 *   2. 每种语言的 key 集合是否与基准（en-US）**完全一致**（多/缺都报）；
 *   3. 基准里有没有"定义了但代码没引用"的 key（可能是废弃或动态拼接）。
 *
 * 语言唯一来源是 `src/shared/locales/*.json`（主/渲染共用）。加一门语言 = 加一份 json，
 * 本脚本自动纳入校验，无需改这里。动态拼接的 key（模板字符串）静态扫不到，用
 * DYNAMIC_PREFIXES 白名单排除。json 顶层的 `_meta`（如机器翻译标记）不算翻译 key。
 *
 * 用法：node scripts/checkI18n.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LOCALES_DIR = 'src/shared/locales'
const REFERENCE = 'en-US'
/** 扫描这些目录里的 .ts/.tsx 收集用到的 key（渲染 + 主进程 + 共享） */
const CODE_DIRS = ['src/renderer/src', 'src/main', 'src/shared']
/** 这些前缀下的 key 由模板字符串动态拼接，静态扫描收不到 */
const DYNAMIC_PREFIXES = [
  'forward.hint_',
  'settings.section_',
  'sftp.perm_',
  'shortcut.',
  'region.'
]

// ---- 读取并展平各语言 json 的叶子 key ----
function flatten(obj, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out.add(key)
  }
  return out
}
function loadLocale(file) {
  const obj = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'))
  delete obj._meta // 顶层元信息（机器翻译标记等）不是翻译 key
  return flatten(obj)
}

const localeFiles = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'))
const defined = Object.fromEntries(
  localeFiles.map((f) => [f.replace(/\.json$/, ''), loadLocale(f)])
)
if (!defined[REFERENCE]) {
  console.error(`FAIL: 找不到基准语言 ${LOCALES_DIR}/${REFERENCE}.json`)
  process.exit(1)
}
const reference = defined[REFERENCE]

// ---- 扫描代码里用到的 key ----
const usedKeys = new Set()
function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      walk(p)
    } else if (/\.tsx?$/.test(name) && !p.includes('i18n') && !p.includes('locales')) {
      const src = readFileSync(p, 'utf8')
      for (const m of src.matchAll(/[^a-zA-Z_$]t\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) usedKeys.add(m[1])
      for (const m of src.matchAll(/(?:descKey|labelKey|noteKey):\s*['"]([a-zA-Z0-9_.]+)['"]/g)) usedKeys.add(m[1])
      for (const m of src.matchAll(/^\s*[a-zA-Z0-9_]+:\s*['"]([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+)['"]/gm))
        usedKeys.add(m[1])
    }
  }
}
for (const d of CODE_DIRS) walk(d)

const isDynamic = (key) => DYNAMIC_PREFIXES.some((p) => key.startsWith(p))

let problems = 0
const report = (label, items) => {
  if (items.length === 0) return
  problems += items.length
  console.log(`\n${label} (${items.length}):`)
  for (const k of items.sort()) console.log(`  - ${k}`)
}

// 1) 代码用到但基准语言没有
report(
  `代码里 t() 用到但 ${REFERENCE} 未定义`,
  [...usedKeys].filter((k) => !reference.has(k) && !isDynamic(k))
)

// 2) N 语言与基准全等（逐语言：缺 / 多）
for (const tag of Object.keys(defined).sort()) {
  if (tag === REFERENCE) continue
  const set = defined[tag]
  report(`${tag} 相对 ${REFERENCE} 缺失`, [...reference].filter((k) => !set.has(k)))
  report(`${tag} 相对 ${REFERENCE} 多出`, [...set].filter((k) => !reference.has(k)))
}

// 3) 基准里定义了但代码没静态引用（排除动态拼接）
report(
  '定义了但无静态引用（确认是否动态使用或已废弃）',
  [...reference].filter((k) => !usedKeys.has(k) && !isDynamic(k))
)

console.log(
  `\n统计：${localeFiles.length} 种语言、基准 ${reference.size} 个 key；代码静态引用 ${usedKeys.size} 个。`
)
if (problems === 0) {
  console.log('i18n 检查通过 ✓')
} else {
  console.log(`发现 ${problems} 处问题。`)
  process.exitCode = 1
}
