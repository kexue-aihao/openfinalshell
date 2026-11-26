#!/usr/bin/env node
/**
 * 构建并暂存 Rust 原生模块（napi-rs 产出的 `ofs_napi.node`）。
 *
 * 参数与语义刻意对齐 `scripts/buildRdpWorker.mjs`：
 *   --platform win|mac|linux   --arch x64|ia32|arm64
 *   --package-disabled         本版本不带原生模块（整模块回退 TS）
 *   --skip-build               只暂存已经构建好的产物（CI 分步时用）
 *
 * 约定：
 * - 产物落 `build/ofs-native/<platform>-<arch>/`，由 electron-builder 的
 *   `extraResources` 复制到 `resources/ofs-native/`，**不进 asar、不进 npm 依赖树**，
 *   因此不会被 `electron-builder install-app-deps` 或 electron-rebuild 碰到。
 * - 失败先清 staging，绝不让上一次的产物冒充这一次的（fail closed）。
 * - 不需要 @napi-rs/cli：MSVC 的 cdylib 就是 PE DLL，改名 `.node` 即可 dlopen。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(process.cwd())
const rustDir = join(root, 'rust')
const stageRoot = join(root, 'build', 'ofs-native')
const markerName = 'OFS-NATIVE-UNAVAILABLE.txt'
const manifestName = 'ofs-native-runtime.json'

function arg(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function detectPlatform() {
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'linux') return 'linux'
  throw new Error(`Unsupported host platform for native addon build: ${process.platform}`)
}

function hostArch() {
  if (process.arch === 'ia32') return 'ia32'
  if (process.arch === 'arm64') return 'arm64'
  return 'x64'
}

const platform = arg('--platform') ?? detectPlatform()
const arch = arg('--arch') ?? hostArch()

const valid = {
  win: ['x64', 'ia32', 'arm64'],
  mac: ['x64', 'arm64'],
  linux: ['x64', 'arm64']
}
if (!valid[platform]?.includes(arch)) {
  throw new Error(`Unsupported native addon target: ${platform}/${arch}`)
}

const stageDir = join(stageRoot, `${platform}-${arch}`)

const triples = {
  win: { x64: 'x86_64-pc-windows-msvc', ia32: 'i686-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
  mac: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' }
}
const onWindows = process.platform === 'win32'
const hostTriple = onWindows
  ? `${hostArch() === 'ia32' ? 'i686' : hostArch() === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
  : process.platform === 'darwin'
    ? `${hostArch() === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
    : `${hostArch() === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`
const target = triples[platform][arch]

// ---------------------------------------------------------------------------
// --package-disabled：本版本不带原生模块（回退三级里的第二级）
// ---------------------------------------------------------------------------
if (hasFlag('--package-disabled')) {
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  writeFileSync(
    join(stageDir, markerName),
    `Native lansync addon is intentionally not shipped for ${platform}/${arch} in this build.\n` +
      'The app falls back to the TypeScript implementation as a whole module.\n',
    'utf8'
  )
  console.log(`Native addon intentionally not staged for ${platform}/${arch}`)
  process.exit(0)
}

if (!existsSync(rustDir)) throw new Error(`Rust workspace is missing: ${rustDir}`)

// 失败即清空：打包必须失败关闭，而不是消费上一次的 staging。
rmSync(stageDir, { recursive: true, force: true })

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? root, stdio: 'inherit', shell: false })
  if (result.error) throw new Error(`Unable to run ${command}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`)
}

const cargo = resolveCargo()
const targetArgs = target === hostTriple ? [] : ['--target', target]
const profileDir = target === hostTriple ? join(rustDir, 'target', 'release') : join(rustDir, 'target', target, 'release')

if (!hasFlag('--skip-build')) {
  const env = { ...process.env }
  // rustup 装出来的 cargo 在 Windows 的 Git Bash 里常常排在 /usr/bin 后面，而那里
  // 有一个 coreutils 的 `link`，链接时会以 "extra operand" 失败。显式把 MSVC 的
  // bin 目录塞进 PATH 前部，避免这个极难看出原因的坑。
  if (onWindows) {
    const msvc = findMsvcBin()
    if (msvc) env.PATH = `${msvc};${env.PATH ?? ''}`
  }
  const result = spawnSync(
    cargo,
    ['build', '--release', '--manifest-path', join(rustDir, 'Cargo.toml'), '-p', 'ofs-napi', ...targetArgs],
    { cwd: root, stdio: 'inherit', shell: false, env }
  )
  if (result.error) throw new Error(`Unable to run ${cargo}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${cargo} build failed with exit code ${result.status}`)
}

/** rustup 的安装脚本会写用户 PATH，但当前 shell 往往还没刷新。 */
function resolveCargo() {
  const explicit = process.env['CARGO']
  if (explicit) return explicit
  const probe = spawnSync('cargo', ['--version'], { shell: false })
  if (!probe.error && probe.status === 0) return 'cargo'
  const home = process.env['USERPROFILE'] ?? process.env['HOME']
  if (home) {
    const candidate = join(home, '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('cargo 不可用：请安装 rustup（https://rustup.rs）或设置 CARGO 指向 cargo 可执行文件')
}

function findMsvcBin() {  const base = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC'
  if (!existsSync(base)) return undefined
  let versions = []
  try {
    versions = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
  } catch {
    return undefined
  }
  for (const version of versions) {
    const candidate = join(base, version, 'bin', 'Hostx64', 'x64')
    if (existsSync(join(candidate, 'link.exe'))) return candidate
  }
  return undefined
}

const artifactNames = ['ofs_napi.dll', 'libofs_napi.so', 'libofs_napi.dylib', 'ofs_napi.node']
const artifact = artifactNames.map((name) => join(profileDir, name)).find((path) => existsSync(path))
if (!artifact) {
  throw new Error(`Native addon artifact not found in ${profileDir} (looked for ${artifactNames.join(', ')})`)
}

mkdirSync(stageDir, { recursive: true })
const staged = join(stageDir, 'ofs_napi.node')
copyFileSync(artifact, staged)

const bytes = readFileSync(staged)
const sha256 = createHash('sha256').update(bytes).digest('hex')
writeFileSync(
  join(stageDir, manifestName),
  `${JSON.stringify(
    {
      schema: 1,
      platform,
      arch,
      target,
      file: 'ofs_napi.node',
      bytes: bytes.byteLength,
      sha256,
      crate: 'ofs-napi',
      abi: 'napi8'
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(
  `Staged native addon ${platform}/${arch}: ${relative(root, staged)} ` +
    `(${statSync(staged).size} bytes, sha256 ${sha256.slice(0, 12)}…)`
)
