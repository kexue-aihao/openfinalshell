/**
 * 渲染进程产物的字节预算护栏。
 *
 * 为什么需要它：渲染进程的库（react / antd / echarts / @xterm，接下来还有代码编辑器）
 * 全是 devDependency，由 Vite 打进一个 bundle。这条路的好处是不碰"3 个运行时依赖"那条红线，
 * 代价是**没人看得见它在长**——加一个库、多引一个语言包，产物涨多少只有量了才知道。
 * 有了阈值之后，"这个功能让包大了多少"就是一个会报红的事实，而不是一句事后回忆。
 *
 * 用法：node scripts/checkBundleBudget.mjs   （需要先 npm run build）
 *
 * ⚠️ 三条反空转断言比阈值本身更重要，因为字节预算最典型的失效方式是**量错了东西**：
 *   1. 产物必须真的找到，且 JS 必须大于 MIN_PLAUSIBLE_JS_BYTES —— 路径写错时
 *      `0 <= 阈值` 永远成立，护栏会变成一句安慰话；
 *   2. JS 必须真的被 minify 过（按"字节/行"判，见 MIN_BYTES_PER_LINE）——
 *      electron-vite 的 renderer 预设写死 `minify: false`，谁把 electron.vite.config.ts
 *      里那行覆盖删掉，产物会胖一倍，而单纯的字节阈值只会告诉你"超了"，
 *      不会告诉你"因为没压缩"；
 *   3. CSS 预算是**独立**的一条，而且卡得很紧（见 MAX_CSS_BYTES 的说明）。
 */
import { gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ASSETS = 'out/renderer/assets'

/**
 * JS 预算。
 *
 * 定标（本机实测，Vite 7 + esbuild 0.25.12）：`minify: false` 的产物 4,560,893 字节、
 * gzip -9 956,495；开 `minify: 'esbuild'` 之后约 2.26 MB / gzip 约 693 KB。
 * 阈值留到 3.3 MB / 950 KB，也就是给"再加一个代码编辑器（CM6 核心 + 语言包约
 * 580 KB minified / 162 KB gzip）"留够余量，同时**对未压缩的产物必然报红**。
 */
const MAX_JS_BYTES = 3_300_000
const MAX_JS_GZIP_BYTES = 950_000

/**
 * CSS 预算，故意卡紧。
 *
 * 现状 33,133 字节。它卡住的是一个具体的决定：编辑器用 CodeMirror 6，
 * 而 CM6 **不发布任何 .css**（样式全靠运行时注入 `<style>`，靠 CSP 里那条
 * 为 antd cssinjs 存在的 `style-src 'unsafe-inline'`）。换成 Monaco 的话，
 * 它光 `editor.main.css` 就是 412,522 字节 —— 是现在整个 CSS 产物的 12.5 倍，
 * 这条会立刻报红。也就是说：这个数字是"选库结论"的护栏，不只是体积管理。
 */
const MAX_CSS_BYTES = 80_000

/** 小于这个数就说明量错了文件（今天最小的可信值是 2.26 MB 那一档） */
const MIN_PLAUSIBLE_JS_BYTES = 1_000_000

/**
 * "被 minify 过"的判据：字节/行。
 * 实测未压缩产物是 38.7（4,560,893 字节 / 117,722 行），esbuild 压过之后是几千。
 * 取 500 —— 离两边都远，不会因为压缩器换个换行策略就误判。
 */
const MIN_BYTES_PER_LINE = 500

let failed = 0
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  failed++
}

if (!existsSync(ASSETS)) {
  fail(`找不到 ${ASSETS}/ —— 先跑 npm run build`)
  process.exit(1)
}

const files = readdirSync(ASSETS)
const jsFiles = files.filter((f) => f.endsWith('.js'))
const cssFiles = files.filter((f) => f.endsWith('.css'))

if (jsFiles.length === 0) fail(`${ASSETS}/ 里没有 .js 产物`)
if (cssFiles.length === 0) fail(`${ASSETS}/ 里没有 .css 产物`)

const sizeOf = (f) => readFileSync(join(ASSETS, f))

let jsBytes = 0
let jsGzip = 0
let jsLines = 0
for (const f of jsFiles) {
  const buf = sizeOf(f)
  jsBytes += buf.length
  jsGzip += gzipSync(buf, { level: 9 }).length
  for (const c of buf) if (c === 10) jsLines++
}

let cssBytes = 0
for (const f of cssFiles) cssBytes += sizeOf(f).length

const bytesPerLine = jsBytes / (jsLines + 1)

console.log(`渲染进程产物（${ASSETS}）：`)
for (const f of [...jsFiles, ...cssFiles].sort()) {
  console.log(`  ${f.padEnd(30)} ${String(sizeOf(f).length).padStart(9)} 字节`)
}
console.log(
  `合计：JS ${jsBytes} 字节（gzip ${jsGzip}，${bytesPerLine.toFixed(0)} 字节/行）、CSS ${cssBytes} 字节`
)

// ---- 反空转：先证明量到的是真东西 ----
if (jsBytes < MIN_PLAUSIBLE_JS_BYTES) {
  fail(
    `JS 产物只有 ${jsBytes} 字节（< ${MIN_PLAUSIBLE_JS_BYTES}）—— 几乎肯定是路径或匹配写错了。` +
      `不先挡住这条，"0 字节 ≤ 阈值"会让整条护栏永远绿。`
  )
}
if (bytesPerLine < MIN_BYTES_PER_LINE) {
  fail(
    `JS 产物只有 ${bytesPerLine.toFixed(1)} 字节/行（< ${MIN_BYTES_PER_LINE}）—— 它没被 minify。` +
      `electron-vite 的 renderer 预设写死 minify:false，检查 electron.vite.config.ts 里那行覆盖还在不在。`
  )
}

// ---- 阈值 ----
if (jsBytes > MAX_JS_BYTES) fail(`JS ${jsBytes} 字节 > 上限 ${MAX_JS_BYTES}`)
if (jsGzip > MAX_JS_GZIP_BYTES) fail(`JS gzip ${jsGzip} 字节 > 上限 ${MAX_JS_GZIP_BYTES}`)
if (cssBytes > MAX_CSS_BYTES) {
  fail(
    `CSS ${cssBytes} 字节 > 上限 ${MAX_CSS_BYTES}。` +
      `这条同时是"编辑器不引入自带样式表"的护栏（Monaco 的 editor.main.css 是 412KB）。`
  )
}

if (failed === 0) {
  console.log('字节预算检查通过 ✓')
} else {
  console.log(`\n发现 ${failed} 处问题。`)
  process.exitCode = 1
}
