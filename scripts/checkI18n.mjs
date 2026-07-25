/**
 * 校验 i18n key 覆盖：代码里用到的 key 是否都在两个语言文件里定义、两边是否对齐、有无未使用的 key。
 * 动态拼接的 key（如 t(`forward.hint_${type}`)）无法静态收集，用 DYNAMIC_PREFIXES 白名单排除。
 *
 * 用法：node scripts/checkI18n.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src/renderer/src'
const LOCALES = {
  'zh-CN': join(SRC, 'i18n/zh-CN.ts'),
  'en-US': join(SRC, 'i18n/en-US.ts')
}
/** 这些前缀下的 key 由模板字符串动态拼接，静态扫描收不到 */
const DYNAMIC_PREFIXES = ['forward.hint_', 'settings.section_', 'sftp.perm_', 'shortcut.']

const usedKeys = new Set()

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      walk(p)
    } else if (/\.tsx?$/.test(name) && !p.includes('i18n')) {
      const src = readFileSync(p, 'utf8')
      for (const m of src.matchAll(/[^a-zA-Z_$]t\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
        usedKeys.add(m[1])
      }
      // 表驱动的 key 常量：descKey: 'x.y' / labelKey: 'x.y' / MAP = { a: 'x.y' }
      for (const m of src.matchAll(/(?:descKey|labelKey):\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
        usedKeys.add(m[1])
      }
      for (const m of src.matchAll(/^\s*[a-zA-Z0-9_]+:\s*['"]([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+)['"]/gm)) {
        usedKeys.add(m[1])
      }
    }
  }
}

/**
 * 从语言文件里按缩进层级提取叶子 key 路径。
 * 兼容 prettier 把长文案折到下一行的写法（`key:` 后换行再跟字符串）。
 */
function definedKeys(file) {
  const out = new Set()
  const stack = []
  let pendingLeaf = null
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trimEnd()

    if (pendingLeaf) {
      // 上一行是 `key:`，本行应为其字符串值
      if (/^\s*['"]/.test(line)) out.add(pendingLeaf)
      pendingLeaf = null
      continue
    }

    const open = /^\s*([a-zA-Z0-9_]+):\s*\{\s*$/.exec(line)
    if (open) {
      stack.push(open[1])
      continue
    }
    if (/^\s*\}/.test(line)) {
      stack.pop()
      continue
    }
    const inline = /^\s*([a-zA-Z0-9_]+):\s*['"]/.exec(line)
    if (inline) {
      // 去掉最外层的 translation 命名空间
      out.add([...stack.slice(1), inline[1]].join('.'))
      continue
    }
    const wrapped = /^\s*([a-zA-Z0-9_]+):\s*$/.exec(line)
    if (wrapped) pendingLeaf = [...stack.slice(1), wrapped[1]].join('.')
  }
  return out
}

walk(SRC)
const defined = Object.fromEntries(Object.entries(LOCALES).map(([k, f]) => [k, definedKeys(f)]))
const isDynamic = (key) => DYNAMIC_PREFIXES.some((p) => key.startsWith(p))

let problems = 0
const report = (label, items) => {
  if (items.length === 0) return
  problems += items.length
  console.log(`\n${label} (${items.length}):`)
  for (const k of items.sort()) console.log(`  - ${k}`)
}

for (const [locale, keys] of Object.entries(defined)) {
  report(
    `代码用到但 ${locale} 缺失`,
    [...usedKeys].filter((k) => !keys.has(k))
  )
}

const [zh, en] = [defined['zh-CN'], defined['en-US']]
report('zh-CN 有而 en-US 缺', [...zh].filter((k) => !en.has(k)))
report('en-US 有而 zh-CN 缺', [...en].filter((k) => !zh.has(k)))
report(
  '定义了但无静态引用（确认是否动态使用）',
  [...zh].filter((k) => !usedKeys.has(k) && !isDynamic(k))
)

console.log(
  `\n统计：静态引用 ${usedKeys.size} 个 key；zh-CN ${zh.size} 个，en-US ${en.size} 个定义。`
)
if (problems === 0) {
  console.log('i18n 检查通过 ✓')
} else {
  console.log(`发现 ${problems} 处问题。`)
  process.exitCode = 1
}
