#!/usr/bin/env node
/**
 * 校验 `ofs_napi.node` 的存在、架构与打包一致性。
 *
 * 用法：
 *   node scripts/checkNativePackaging.mjs --platform win --arch x64
 *   node scripts/checkNativePackaging.mjs --platform win --arch x64 --app-dir release/win-unpacked
 *   node scripts/checkNativePackaging.mjs --platform win --arch arm64 --expect-absent
 *
 * 参数与 `scripts/checkRdpWorkerPackage.mjs` 对齐：`--stage-dir` 默认
 * `build/ofs-native`（平铺，每次只暂存一个架构）；`--expect-absent` 断言
 * 「本版本不带原生模块」（此时 staging 里必须有 UNAVAILABLE 标记，打包产物里必须没有 .node）。
 *
 * 架构检查看的是二进制的真实头（PE / ELF / Mach-O），不是文件名 ——
 * 把 x64 的 DLL 改名成 arm64 是这类流水线最常见的静默错误。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

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
  return 'linux'
}

function hostArch() {
  if (process.arch === 'ia32') return 'ia32'
  if (process.arch === 'arm64') return 'arm64'
  return 'x64'
}

const platform = arg('--platform') ?? detectPlatform()
const arch = arg('--arch') ?? hostArch()
const valid = { win: ['x64', 'ia32', 'arm64'], mac: ['x64', 'arm64'], linux: ['x64', 'arm64'] }
if (!valid[platform]?.includes(arch)) throw new Error(`Unsupported target: ${platform}/${arch}`)

const stageDir = arg('--stage-dir') ?? join(root, 'build', 'ofs-native')
const appDir = arg('--app-dir')
const addonName = 'ofs_napi.node'
const markerName = 'OFS-NATIVE-UNAVAILABLE.txt'
const manifestName = 'ofs-native-runtime.json'

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function resourcesDir() {
  if (!appDir) return undefined
  if (platform === 'mac') {
    const entries = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
      .map((entry) => join(appDir, entry.name, 'Contents', 'Resources'))
    const found = entries.find((path) => existsSync(path))
    if (!found) throw new Error(`No .app/Contents/Resources under ${appDir}`)
    return found
  }
  const resources = join(appDir, 'resources')
  if (!existsSync(resources)) throw new Error(`No resources directory under ${appDir}`)
  return resources
}

function assertArchitecture(path, expectedPlatform, expectedArch) {
  const buffer = readFileSync(path)
  if (buffer.byteLength < 64) throw new Error(`${path} is too small to be a native addon`)

  if (expectedPlatform === 'win') {
    if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) throw new Error(`${path} is not a PE image (missing MZ)`)
    const peOffset = buffer.readUInt32LE(0x3c)
    if (buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
      throw new Error(`${path} has no PE header`)
    }
    const machine = buffer.readUInt16LE(peOffset + 4)
    const expected = { x64: 0x8664, ia32: 0x014c, arm64: 0xaa64 }[expectedArch]
    if (machine !== expected) {
      throw new Error(`${path} is PE machine 0x${machine.toString(16)}, expected ${expectedArch} (0x${expected.toString(16)})`)
    }
    return 'PE'
  }

  if (expectedPlatform === 'linux') {
    if (buffer[0] !== 0x7f || buffer.toString('latin1', 1, 4) !== 'ELF') {
      throw new Error(`${path} is not an ELF image`)
    }
    const is64 = buffer[4] === 2
    const machine = buffer.readUInt16LE(18)
    const expected = expectedArch === 'arm64' ? 183 : 62
    if (machine !== expected) {
      throw new Error(`${path} is ELF machine ${machine}, expected ${expected} for ${expectedArch}`)
    }
    if (expectedArch === 'x64' && !is64) throw new Error(`${path} is a 32-bit ELF, expected x86_64`)
    return 'ELF'
  }

  const magic = buffer.readUInt32LE(0)
  if (magic !== 0xfeedfacf && magic !== 0xfeedface) {
    throw new Error(`${path} is not a Mach-O image`)
  }
  const cpuType = buffer.readUInt32LE(4)
  const expected = expectedArch === 'arm64' ? 0x0100000c : 0x01000007
  if (cpuType !== expected) {
    throw new Error(`${path} is Mach-O cputype 0x${cpuType.toString(16)}, expected ${expectedArch}`)
  }
  return 'Mach-O'
}

function hostMatchesTarget() {
  return detectPlatform() === platform && hostArch() === arch
}

// ---------------------------------------------------------------------------
// --expect-absent
// ---------------------------------------------------------------------------
if (hasFlag('--expect-absent')) {
  if (!existsSync(stageDir)) throw new Error(`Staging directory missing: ${stageDir}`)
  if (!existsSync(join(stageDir, markerName))) {
    throw new Error(`Expected ${markerName} in ${stageDir} (use --package-disabled when staging)`)
  }
  const stray = readdirSync(stageDir).filter((name) => name.endsWith('.node'))
  if (stray.length > 0) throw new Error(`--expect-absent but staging has ${stray.join(', ')}`)

  const resources = resourcesDir()
  if (resources) {
    const packagedDir = join(resources, 'ofs-native')
    if (existsSync(packagedDir)) {
      const packed = readdirSync(packagedDir).filter((name) => name.endsWith('.node'))
      if (packed.length > 0) throw new Error(`--expect-absent but packaged app has ${packed.join(', ')}`)
      if (!existsSync(join(packagedDir, markerName))) {
        throw new Error(`Packaged ofs-native directory is missing ${markerName}`)
      }
    } else {
      throw new Error(`Packaged app has no resources/ofs-native/${markerName}`)
    }
  }
  console.log(`OK ${platform}/${arch}: native addon intentionally absent`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------
const stagedAddon = join(stageDir, addonName)
if (!existsSync(stagedAddon)) throw new Error(`Missing staged addon: ${stagedAddon}`)
const stats = statSync(stagedAddon)
if (!stats.isFile() || stats.size === 0) throw new Error(`Staged addon is empty: ${stagedAddon}`)

const format = assertArchitecture(stagedAddon, platform, arch)

const manifestPath = join(stageDir, manifestName)
if (!existsSync(manifestPath)) throw new Error(`Missing ${manifestName} in ${stageDir}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.schema !== 1) throw new Error(`Unsupported manifest schema: ${manifest.schema}`)
if (manifest.platform !== platform || manifest.arch !== arch) {
  throw new Error(`Manifest target ${manifest.platform}/${manifest.arch} does not match ${platform}/${arch}`)
}
if (manifest.file !== addonName) throw new Error(`Manifest file ${manifest.file} does not match ${addonName}`)
const stagedHash = sha256(stagedAddon)
if (manifest.sha256 !== stagedHash) throw new Error('Staged addon hash does not match manifest')

const resources = resourcesDir()
if (resources) {
  const packedAddon = join(resources, 'ofs-native', addonName)
  if (!existsSync(packedAddon)) throw new Error(`Packaged app is missing resources/ofs-native/${addonName}`)
  assertArchitecture(packedAddon, platform, arch)
  const packedHash = sha256(packedAddon)
  if (packedHash !== stagedHash) {
    throw new Error(`Packaged addon differs from staging (${packedHash} != ${stagedHash})`)
  }
  // 打包目录里出现 UNAVAILABLE 标记说明 staging 被覆盖过，是真的错了。
  if (existsSync(join(resources, 'ofs-native', markerName))) {
    throw new Error('Packaged ofs-native contains the UNAVAILABLE marker while an addon is present')
  }
}

if (hostMatchesTarget()) {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const binding = require(stagedAddon)
  if (typeof binding.nativeAbiLevel !== 'function' || binding.nativeAbiLevel() !== 8) {
    throw new Error('Native addon does not report the expected Node-API level (8)')
  }
  if (typeof binding.nativeSelfTest !== 'function' || binding.nativeSelfTest() !== true) {
    throw new Error('Native addon self-test failed')
  }
  console.log(`OK ${platform}/${arch}: ${format} addon loads (${binding.nativeVersion()})`)
} else {
  console.log(`OK ${platform}/${arch}: ${format} addon present (cross target, not loaded)`)
}
