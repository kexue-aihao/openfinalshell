import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(process.cwd())
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
function truthyEnv(name) {
  const value = process.env[name]
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'on' || value === 'ON'
}
function detectPlatform() {
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'linux') return 'linux'
  throw new Error(`Unsupported host platform for RDP worker check: ${process.platform}`)
}
function canRunTarget(targetPlatform, targetArch) {
  const hostArch = process.arch === 'ia32' ? 'ia32' : process.arch === 'arm64' ? 'arm64' : 'x64'
  const currentPlatform = detectPlatform()
  if (targetPlatform !== currentPlatform) return false
  if (targetArch === hostArch) return true
  if (targetPlatform === 'mac' && targetArch === 'universal') return true
  if (targetPlatform === 'win' && hostArch === 'x64' && targetArch === 'ia32') return true
  return false
}
function runtimeEnv(workerPath) {
  if (process.platform !== 'win32') return process.env
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const system32 = join(systemRoot, 'System32')
  return {
    ...process.env,
    PATH: [dirname(workerPath), system32, systemRoot].filter(Boolean).join(';')
  }
}
function assertFreerdpCapability(workerPath) {
  const result = spawnSync(workerPath, ['--self-test'], {
    env: runtimeEnv(workerPath),
    maxBuffer: 1024 * 1024,
    shell: false
  })
  if (result.error) throw new Error(`Unable to run worker self-test: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`Worker self-test exited with ${result.status}: ${result.stderr.toString('utf8')}`)
  }
  const output = result.stdout
  if (output.length < 16 || output.toString('ascii', 0, 4) !== 'OFSR' || output.readUInt16LE(4) !== 1 || output.readUInt8(6) !== 0x01) {
    throw new Error('Worker self-test did not emit a valid HELLO frame')
  }
  const length = output.readUInt32LE(8)
  if (output.length !== 16 + length) throw new Error('Worker self-test emitted a truncated or multi-frame response')
  const hello = JSON.parse(output.subarray(16).toString('utf8'))
  const capabilities = Array.isArray(hello.capabilities) ? hello.capabilities : []
  if (hello.workerVersion !== 'freerdp' || !capabilities.includes('freerdp') || capabilities.includes('mock')) {
    throw new Error(`Worker is not a FreeRDP backend build: ${JSON.stringify(hello)}`)
  }
}
const platform = arg('--platform')
const arch = arg('--arch')
const stageDir = resolve(root, arg('--stage-dir') ?? join('build', 'rdp-worker'))
const appDirArg = arg('--app-dir')
const requireFreerdp = hasFlag('--require-freerdp') || truthyEnv('OFS_RDP_REQUIRE_FREERDP')
const expectAbsent = hasFlag('--expect-absent')
if (!platform || !arch) throw new Error('Usage: node scripts/checkRdpWorkerPackage.mjs --platform <win|mac|linux> --arch <arch> [--stage-dir path] [--app-dir path]')
const executableName = platform === 'win' ? 'ofs-rdp-worker.exe' : 'ofs-rdp-worker'
const runtimeManifestName = 'rdp-worker-runtime.json'
const thirdPartyNoticeName = 'THIRD-PARTY-NOTICES.rdp-worker.txt'
const unavailableMarkerName = 'RDP-WORKER-UNAVAILABLE.txt'
function isRuntimeFile(name) {
  const lower = name.toLowerCase()
  if (platform === 'win') return lower.endsWith('.dll') || lower.includes('.dll.')
  if (platform === 'mac') return lower.endsWith('.dylib') || lower.includes('.dylib.')
  return lower.endsWith('.so') || lower.includes('.so.')
}
function findWorkerExecutables(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return []
  const matches = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) matches.push(...findWorkerExecutables(path))
    else if (entry.isFile() && (entry.name === 'ofs-rdp-worker' || entry.name === 'ofs-rdp-worker.exe')) matches.push(path)
  }
  return matches
}
const expected = {
  win: ['x64', 'ia32', 'arm64'],
  mac: ['x64', 'arm64', 'universal'],
  linux: ['x64', 'arm64', 'armv7l']
}
if (!expected[platform]?.includes(arch)) throw new Error(`Unsupported RDP worker target: ${platform}/${arch}`)
if (!existsSync(stageDir) || !statSync(stageDir).isDirectory()) throw new Error(`Missing worker staging directory: ${stageDir}`)
const stagedPath = join(stageDir, executableName)
const stagedFiles = readdirSync(stageDir).filter((name) => name !== '.DS_Store')
if (expectAbsent) {
  if (requireFreerdp) throw new Error('--expect-absent cannot be combined with --require-freerdp')
  const stagedWorkers = findWorkerExecutables(stageDir)
  if (stagedWorkers.length > 0) {
    throw new Error(`Unsupported release target must not stage an RDP worker: ${stagedWorkers.join(', ')}`)
  }
  if (appDirArg) {
    const appDir = resolve(root, appDirArg)
    let resourcesDir = join(appDir, 'resources')
    if (platform === 'mac' || basename(appDir).endsWith('.app')) resourcesDir = join(appDir, 'Contents', 'Resources')
    const packagedWorkerDir = join(resourcesDir, 'rdp-worker')
    const packagedWorkers = findWorkerExecutables(packagedWorkerDir)
    if (packagedWorkers.length > 0) {
      throw new Error(`Unsupported release target packaged an RDP worker: ${packagedWorkers.join(', ')}`)
    }
    const packagedMarker = join(packagedWorkerDir, unavailableMarkerName)
    if (!existsSync(packagedMarker) || !statSync(packagedMarker).isFile()) {
      throw new Error(`Unsupported release target package is missing ${unavailableMarkerName} at ${packagedMarker}`)
    }
  }
  const unexpectedFiles = stagedFiles.filter((name) => name !== unavailableMarkerName && name !== '.DS_Store')
  if (!stagedFiles.includes(unavailableMarkerName)) {
    throw new Error(`Unsupported release target must contain ${unavailableMarkerName} so the disabled state is explicit`)
  }
  if (unexpectedFiles.length > 0) {
    throw new Error(`Unsupported release target staging contains unexpected files: ${unexpectedFiles.join(', ')}`)
  }
  console.log(`OK ${platform}/${arch}: RDP worker intentionally absent`)
  process.exit(0)
}
if (!stagedFiles.includes(executableName)) throw new Error(`Worker staging is missing ${executableName}; found ${stagedFiles.join(', ') || '(empty)'}`)
const stagedStat = statSync(stagedPath)
if (!stagedStat.isFile() || stagedStat.size === 0) throw new Error(`Staged worker is empty: ${stagedPath}`)
if (platform !== 'win' && (stagedStat.mode & 0o111) === 0) throw new Error(`Staged worker is not executable: ${stagedPath}`)
const stagedManifestPath = join(stageDir, runtimeManifestName)
const stagedNoticePath = join(stageDir, thirdPartyNoticeName)
if (!existsSync(stagedManifestPath) || !statSync(stagedManifestPath).isFile()) throw new Error(`Missing RDP worker runtime manifest: ${stagedManifestPath}`)
if (!existsSync(stagedNoticePath) || !statSync(stagedNoticePath).isFile()) throw new Error(`Missing RDP worker third-party notice: ${stagedNoticePath}`)
const manifest = JSON.parse(readFileSync(stagedManifestPath, 'utf8'))
if (manifest.schema !== 1 || manifest.platform !== platform || manifest.arch !== arch || manifest.executable !== executableName) {
  throw new Error(`RDP worker runtime manifest does not match ${platform}/${arch}: ${JSON.stringify(manifest)}`)
}
if (manifest.noticeFile !== thirdPartyNoticeName || !Array.isArray(manifest.runtimeFiles) || !Array.isArray(manifest.licenseFiles)) {
  throw new Error(`RDP worker runtime manifest is incomplete: ${JSON.stringify(manifest)}`)
}
if (manifest.licenseFiles.length === 0) {
  throw new Error('RDP worker runtime manifest must include at least one redistributed dependency license')
}
const manifestRuntimeFiles = new Set(manifest.runtimeFiles.map((name) => String(name).toLowerCase()))
const unlistedRuntimeFiles = stagedFiles.filter((name) => isRuntimeFile(name) && !manifestRuntimeFiles.has(name.toLowerCase()))
if (unlistedRuntimeFiles.length > 0) {
  throw new Error(`RDP worker staging contains runtime files missing from the manifest: ${unlistedRuntimeFiles.join(', ')}`)
}
for (const name of [...manifest.runtimeFiles, ...manifest.licenseFiles]) {
  const stagedDependency = join(stageDir, name)
  if (!existsSync(stagedDependency) || !statSync(stagedDependency).isFile()) {
    throw new Error(`RDP worker manifest references a missing staged file: ${stagedDependency}`)
  }
}
if (requireFreerdp && manifest.backend !== 'freerdp') throw new Error(`RDP worker manifest does not declare a FreeRDP backend: ${JSON.stringify(manifest)}`)
if (requireFreerdp && platform === 'win') {
  const runtimeFiles = manifest.runtimeFiles.map((name) => String(name).toLowerCase())
  if (!runtimeFiles.some((name) => name.includes('freerdp') || name.includes('winpr'))) {
    throw new Error(`Windows FreeRDP package must stage FreeRDP/WinPR runtime DLLs: ${JSON.stringify(manifest.runtimeFiles)}`)
  }
  const notice = readFileSync(stagedNoticePath, 'utf8')
  if (!notice.includes('FreeRDP') || !notice.includes('WinPR')) {
    throw new Error('RDP worker third-party notice must name FreeRDP and WinPR')
  }
}
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
if (requireFreerdp && canRunTarget(platform, arch)) assertFreerdpCapability(stagedPath)

if (appDirArg) {
  const appDir = resolve(root, appDirArg)
  let resourcesDir = join(appDir, 'resources')
  if (platform === 'mac') resourcesDir = join(appDir, 'Contents', 'Resources')
  else if (basename(appDir).endsWith('.app')) resourcesDir = join(appDir, 'Contents', 'Resources')
  const packagedPath = join(resourcesDir, 'rdp-worker', executableName)
  if (!existsSync(packagedPath) || !statSync(packagedPath).isFile()) {
    throw new Error(`Packaged worker missing at ${packagedPath}`)
  }
  if (platform !== 'win' && (statSync(packagedPath).mode & 0o111) === 0) {
    throw new Error(`Packaged worker is not executable: ${packagedPath}`)
  }
  if (digest(packagedPath) !== digest(stagedPath)) {
    throw new Error(`Packaged worker checksum differs from staged worker: ${packagedPath}`)
  }
  const packagedManifestPath = join(resourcesDir, 'rdp-worker', runtimeManifestName)
  const packagedNoticePath = join(resourcesDir, 'rdp-worker', thirdPartyNoticeName)
  if (!existsSync(packagedManifestPath) || !statSync(packagedManifestPath).isFile()) {
    throw new Error(`Packaged RDP runtime manifest missing at ${packagedManifestPath}`)
  }
  if (!existsSync(packagedNoticePath) || !statSync(packagedNoticePath).isFile()) {
    throw new Error(`Packaged RDP third-party notice missing at ${packagedNoticePath}`)
  }
  if (digest(packagedManifestPath) !== digest(stagedManifestPath)) {
    throw new Error(`Packaged RDP runtime manifest checksum differs from staged manifest: ${packagedManifestPath}`)
  }
  if (digest(packagedNoticePath) !== digest(stagedNoticePath)) {
    throw new Error(`Packaged RDP third-party notice checksum differs from staged notice: ${packagedNoticePath}`)
  }
  for (const name of manifest.runtimeFiles) {
    const stagedRuntime = join(stageDir, name)
    const packagedRuntime = join(resourcesDir, 'rdp-worker', name)
    if (!existsSync(packagedRuntime) || !statSync(packagedRuntime).isFile()) {
      throw new Error(`Packaged RDP runtime dependency missing at ${packagedRuntime}`)
    }
    if (digest(packagedRuntime) !== digest(stagedRuntime)) {
      throw new Error(`Packaged RDP runtime dependency checksum differs from staged file: ${packagedRuntime}`)
    }
  }
  const packagedWorkerDirEntries = readdirSync(join(resourcesDir, 'rdp-worker'))
  const packagedRuntimeFiles = packagedWorkerDirEntries.filter(isRuntimeFile)
  const unlistedPackagedRuntimeFiles = packagedRuntimeFiles.filter((name) => !manifestRuntimeFiles.has(name.toLowerCase()))
  if (unlistedPackagedRuntimeFiles.length > 0) {
    throw new Error(`Packaged RDP runtime files missing from the manifest: ${unlistedPackagedRuntimeFiles.join(', ')}`)
  }
  for (const name of manifest.licenseFiles) {
    const stagedLicense = join(stageDir, name)
    const packagedLicense = join(resourcesDir, 'rdp-worker', name)
    if (!existsSync(packagedLicense) || !statSync(packagedLicense).isFile()) {
      throw new Error(`Packaged RDP license file missing at ${packagedLicense}`)
    }
    if (digest(packagedLicense) !== digest(stagedLicense)) {
      throw new Error(`Packaged RDP license file checksum differs from staged file: ${packagedLicense}`)
    }
  }
  if (requireFreerdp && canRunTarget(platform, arch)) assertFreerdpCapability(packagedPath)
  console.log(`OK ${platform}/${arch}: ${packagedPath}`)
} else {
  console.log(`OK ${platform}/${arch}: ${stagedPath}`)
}
