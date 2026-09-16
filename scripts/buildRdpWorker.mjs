import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(process.cwd())
const sourceDir = join(root, 'native', 'rdp-worker')
const stageDir = join(root, 'build', 'rdp-worker')
const cmakeRoot = join(root, 'build', 'rdp-worker-cmake')

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
  throw new Error(`Unsupported host platform for RDP worker build: ${process.platform}`)
}

const platform = arg('--platform') ?? detectPlatform()
const hostArch = process.arch === 'ia32' ? 'ia32' : process.arch === 'arm64' ? 'arm64' : 'x64'
const arch = arg('--arch') ?? (platform === 'mac' && hostArch === 'x64' ? 'x64' : hostArch)
const valid = {
  win: ['x64', 'ia32', 'arm64'],
  mac: ['x64', 'arm64', 'universal'],
  linux: ['x64', 'arm64', 'armv7l']
}
if (!valid[platform]?.includes(arch)) {
  throw new Error(`Unsupported RDP worker target: ${platform}/${arch}`)
}
if (!existsSync(sourceDir)) throw new Error(`RDP worker source directory is missing: ${sourceDir}`)

const packageDisabled = hasFlag('--package-disabled')
if (packageDisabled) {
  if (platform === 'win' && arch === 'x64') {
    throw new Error('Windows x64 release packages require the real FreeRDP worker')
  }
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  writeFileSync(join(stageDir, 'RDP-WORKER-UNAVAILABLE.txt'),
    `Embedded RDP is not shipped for ${platform}/${arch} before NATIVE-03. Use the explicit system-client fallback.\n`,
    'utf8')
  console.log(`RDP worker intentionally not staged for ${platform}/${arch}`)
  process.exit(0)
}

function canRunTarget(targetPlatform, targetArch) {
  const currentPlatform = detectPlatform()
  if (targetPlatform !== currentPlatform) return false
  if (targetArch === hostArch) return true
  if (targetPlatform === 'mac' && targetArch === 'universal') return true
  if (targetPlatform === 'win' && hostArch === 'x64' && targetArch === 'ia32') return true
  return false
}

/**
 * CMake's `-A` option is only supported by generators such as Visual Studio.
 * Ninja is a common default on Windows (including MSYS2), so passing `-A`
 * unconditionally makes an otherwise valid x64 build fail during configure.
 * Prefer an explicitly configured generator and otherwise read CMake's marked
 * default from `cmake --help`.
 */
function detectCmakeGenerator() {
  const configured = process.env.CMAKE_GENERATOR?.trim()
  if (configured) return configured
  const result = spawnSync('cmake', ['--help'], { encoding: 'utf8', shell: false })
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
  const match = result.stdout.match(/^\s*\*\s+(.+?)\s+=/m)
  return match?.[1]?.trim()
}

function supportsGeneratorPlatform(generator) {
  return typeof generator === 'string' && /^Visual Studio\s+\d{4}/i.test(generator)
}

const buildDir = join(cmakeRoot, `${platform}-${arch}`)
const requireFreerdp = hasFlag('--require-freerdp') || truthyEnv('OFS_RDP_REQUIRE_FREERDP')
function externalEnvError(message) {
  throw new Error(`BLOCKED_EXTERNAL_ENV: ${message}`)
}

if (requireFreerdp && process.env.CMAKE_TOOLCHAIN_FILE && !existsSync(process.env.CMAKE_TOOLCHAIN_FILE)) {
  externalEnvError(`CMAKE_TOOLCHAIN_FILE does not exist: ${process.env.CMAKE_TOOLCHAIN_FILE}`)
}
const cmakeArgs = [
  '-S', sourceDir,
  '-B', buildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DOFS_RDP_ENABLE_FREERDP=ON',
  `-DOFS_RDP_REQUIRE_FREERDP=${requireFreerdp ? 'ON' : 'OFF'}`
]
if (process.env.CMAKE_TOOLCHAIN_FILE) cmakeArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${process.env.CMAKE_TOOLCHAIN_FILE}`)
if (process.env.CMAKE_PREFIX_PATH) cmakeArgs.push(`-DCMAKE_PREFIX_PATH=${process.env.CMAKE_PREFIX_PATH}`)
if (platform === 'win') {
  const generator = detectCmakeGenerator()
  if (supportsGeneratorPlatform(generator)) {
    cmakeArgs.push('-A', ({ x64: 'x64', ia32: 'Win32', arm64: 'ARM64' })[arch])
  } else if (arch !== hostArch) {
    throw new Error(
      `Windows ${arch} worker builds require a Visual Studio CMake generator or an explicit cross-compilation toolchain; detected ${generator ?? 'an unknown generator'}`
    )
  }
} else if (platform === 'mac') {
  cmakeArgs.push('-DCMAKE_OSX_ARCHITECTURES=' + ({ x64: 'x86_64', arm64: 'arm64', universal: 'x86_64;arm64' })[arch])
} else if (arch === 'armv7l') {
  // The Linux release job installs these cross compilers in its container.
  cmakeArgs.push(
    '-DCMAKE_SYSTEM_NAME=Linux',
    '-DCMAKE_SYSTEM_PROCESSOR=arm',
    `-DCMAKE_C_COMPILER=${process.env.CMAKE_C_COMPILER ?? 'arm-linux-gnueabihf-gcc'}`,
    `-DCMAKE_CXX_COMPILER=${process.env.CMAKE_CXX_COMPILER ?? 'arm-linux-gnueabihf-g++'}`
  )
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? root, stdio: 'inherit', shell: false })
  if (result.error) {
    const prefix = options.externalEnv ? 'BLOCKED_EXTERNAL_ENV: ' : ''
    throw new Error(`${prefix}Unable to run ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const prefix = options.externalEnv ? 'BLOCKED_EXTERNAL_ENV: ' : ''
    throw new Error(`${prefix}${command} failed with exit code ${result.status}`)
  }
}

// Keep build directories target-specific so a universal/macOS build cannot
// accidentally reuse an x64 configure cache.  These are generated paths,
// never user-provided paths.
rmSync(buildDir, { recursive: true, force: true })
// Do not leave a previous target's executable available if configure or build
// fails. Packaging must fail closed instead of consuming stale staging data.
rmSync(stageDir, { recursive: true, force: true })
run('cmake', cmakeArgs, {
  externalEnv: requireFreerdp,
})
run('cmake', ['--build', buildDir, '--config', 'Release', '--parallel'])
if (!hasFlag('--skip-test') && canRunTarget(platform, arch)) {
  run('ctest', ['-C', 'Release', '--output-on-failure'], { cwd: buildDir })
} else if (!hasFlag('--skip-test')) {
  console.log(`Skipping RDP worker CTest for non-runnable target ${platform}/${arch} on ${detectPlatform()}/${hostArch}`)
}

const executableName = platform === 'win' ? 'ofs-rdp-worker.exe' : 'ofs-rdp-worker'
const runtimeManifestName = 'rdp-worker-runtime.json'
const thirdPartyNoticeName = 'THIRD-PARTY-NOTICES.rdp-worker.txt'
const sdk = JSON.parse(readFileSync(join(buildDir, 'rdp-worker-sdk.json'), 'utf8'))
if (![0, 2, 3].includes(sdk.freerdpMajor) || (requireFreerdp && sdk.freerdpMajor === 0)) {
  throw new Error('Native configure did not report a supported FreeRDP SDK major version')
}
function findExecutable(directory) {
  const matches = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) matches.push(...findExecutable(path))
    else if (entry.isFile() && entry.name === executableName) matches.push(path)
  }
  return matches
}
const matches = findExecutable(buildDir)
if (matches.length !== 1) {
  throw new Error(`Expected exactly one ${executableName} in ${buildDir}, found ${matches.length}`)
}

mkdirSync(stageDir, { recursive: true })
const staged = join(stageDir, executableName)
copyFileSync(matches[0], staged)
if (platform !== 'win') chmodSync(staged, 0o755)

function runtimeExtensionsFor(targetPlatform) {
  if (targetPlatform === 'win') return ['.dll']
  if (targetPlatform === 'mac') return ['.dylib']
  return ['.so']
}

function isRuntimeDependency(name, extensions) {
  const lower = name.toLowerCase()
  return extensions.some((extension) => lower.endsWith(extension) || lower.includes(`${extension}.`))
}

function copySiblingRuntimeDependencies(executablePath) {
  const sourceRuntimeDir = dirname(executablePath)
  const extensions = runtimeExtensionsFor(platform)
  const copied = new Set()
  const copyFrom = (directory, allowedNames) => {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !isRuntimeDependency(entry.name, extensions)) continue
      if (allowedNames && !allowedNames.has(entry.name.toLowerCase())) continue
      copyFileSync(join(directory, entry.name), join(stageDir, entry.name))
      copied.add(entry.name)
    }
  }
  copyFrom(sourceRuntimeDir)
  if (requireFreerdp && platform === 'win') {
    for (const root of vcpkgRoots()) copyFrom(join(root, 'bin'))
    for (const root of pkgConfigRoots()) {
      // MSYS2 prefixes contain many unrelated DLLs. Keep only the transitive
      // imports reported by ldd; if ldd is unavailable, retain the historical
      // broad-copy fallback so a developer build still remains runnable.
      copyFrom(join(root, 'bin'), runtimeNamesFromLdd(executablePath, root))
    }
  }
  return [...copied].sort((a, b) => a.localeCompare(b))
}

// Copy Unix runtime libraries before packaging; development-machine library
// paths must never be required by the installed Worker. Audio device modules
// are dlopen dependencies, so include them as explicit graph roots.
function copyUnixRuntimeDependencies() {
  if (platform === 'win' || !requireFreerdp) return []
  const copied = new Map()
  const queue = [{ source: matches[0], target: staged }]
  const prefixes = pkgConfigRoots()
  const inspect = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', shell: false })
    if (result.status !== 0) throw new Error(`Runtime dependency inspection failed: ${command}: ${result.stderr ?? result.error?.message}`)
    return result.stdout
  }
  const add = (source, name = basename(source)) => {
    const canonical = realpathSync(source)
    if (copied.has(name)) {
      if (copied.get(name) !== canonical) throw new Error(`Conflicting runtime libraries named ${name}`)
      return
    }
    const target = join(stageDir, name)
    copyFileSync(canonical, target)
    chmodSync(target, 0o755)
    copied.set(name, canonical)
    queue.push({ source: canonical, target })
  }
  const findPlugins = (directory, depth = 0) => {
    if (depth > 2 || !existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && /freerdp|aarch64|x86_64/.test(entry.name)) {
        if (/freerdp[23]/.test(entry.name) && !entry.name.includes(`freerdp${sdk.freerdpMajor}`)) continue
        findPlugins(path, depth + 1)
      }
      else if (/^(lib)?rdpsnd-client-(mac|pulse|alsa)\.(so|dylib)$/.test(entry.name)) add(path)
    }
  }
  for (const prefix of prefixes) findPlugins(join(prefix, 'lib'))
  const systemLinux = /^(?:ld-linux[^/]*|lib(?:c|m|pthread|dl|rt|util|resolv)\.so(?:\..*)?)$/
  for (let index = 0; index < queue.length; index++) {
    const { source, target } = queue[index]
    if (platform === 'linux') {
      const dependencies = inspect('ldd', [source])
      if (/=>\s+not found/.test(dependencies)) throw new Error(`Unresolved Worker dependency in ${source}`)
      for (const line of dependencies.split('\n')) {
        const match = line.match(/^\s*(\S+)\s+=>\s+(\/[^\s]+)\s+\(/)
        if (match && !systemLinux.test(match[1])) add(match[2], match[1])
      }
      run('patchelf', ['--set-rpath', '$ORIGIN', target])
    } else {
      const dependencyLines = inspect('otool', ['-L', source]).split('\n').slice(1)
      const loadCommands = inspect('otool', ['-l', source])
      const rpaths = [...loadCommands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset/g)].map((match) => match[1])
      const expand = (path) => path.replace('@loader_path', dirname(source)).replace('@executable_path', dirname(matches[0]))
      for (const line of dependencyLines) {
        const match = line.match(/^\s*(.*?) \(compatibility version /)
        if (!match || match[1].startsWith('/usr/lib/') || match[1].startsWith('/System/Library/')) continue
        const name = match[1]
        const candidates = name.startsWith('@rpath/')
          ? [...rpaths.map((path) => join(expand(path), name.slice(7))), ...prefixes.map((prefix) => join(prefix, 'lib', name.slice(7)))]
          : [expand(name)]
        const dependency = candidates.find((path) => existsSync(path))
        if (!dependency) throw new Error(`Cannot resolve macOS dependency ${name} from ${source}`)
        if (realpathSync(dependency) === realpathSync(source)) continue
        add(dependency, basename(name))
        run('install_name_tool', ['-change', name, `@loader_path/${basename(name)}`, target])
      }
      if (target !== staged) run('install_name_tool', ['-id', `@loader_path/${basename(target)}`, target])
      // install_name_tool invalidates any existing ad-hoc signature. The app
      // signing step can replace this signature with the release identity.
      run('codesign', ['--force', '--sign', '-', target])
    }
  }
  return [...copied.keys()].sort()
}

function copyOpenSslProviderModules() {
  if (!requireFreerdp || platform !== 'win') return []
  const candidates = []
  for (const root of [...vcpkgRoots(), ...pkgConfigRoots()]) {
    candidates.push(join(root, 'lib', 'ossl-modules'))
    candidates.push(join(root, 'bin', 'ossl-modules'))
    // The vcpkg Windows OpenSSL port installs provider modules directly in
    // the runtime bin directory, while MSYS2 keeps them under ossl-modules.
    candidates.push(join(root, 'bin'))
    candidates.push(join(root, 'tools', 'openssl'))
  }
  const copied = []
  for (const directory of candidates) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^legacy(?:[-.].*)?\.dll$/i.test(entry.name)) continue
      const target = join(stageDir, 'ossl-modules', 'legacy.dll')
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(directory, entry.name), target)
      copied.push(relative(stageDir, target).replaceAll('\\', '/'))
    }
  }
  const unique = [...new Set(copied)].sort((a, b) => a.localeCompare(b))
  if (unique.length === 0) {
    throw new Error('Required FreeRDP Windows package is missing the OpenSSL legacy provider module')
  }
  return unique
}

function vcpkgTriplet() {
  if (platform !== 'win') return null
  return ({ x64: 'x64-windows', ia32: 'x86-windows', arm64: 'arm64-windows' })[arch] ?? null
}

function vcpkgRoots() {
  const triplet = vcpkgTriplet()
  if (!triplet) return []
  const candidates = []
  const add = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value)
  }
  add(process.env.VCPKG_INSTALLED_DIR ? join(process.env.VCPKG_INSTALLED_DIR, triplet) : null)
  add(process.env.VCPKG_ROOT ? join(process.env.VCPKG_ROOT, 'installed', triplet) : null)
  add(process.env.VCPKG_INSTALLATION_ROOT ? join(process.env.VCPKG_INSTALLATION_ROOT, 'installed', triplet) : null)
  add(join(buildDir, 'vcpkg_installed', triplet))
  for (const value of (process.env.CMAKE_PREFIX_PATH ?? '').split(platform === 'win' ? ';' : ':')) add(value)
  return candidates.filter((candidate) => existsSync(candidate) && statSync(candidate).isDirectory())
}

function pkgConfigRoots() {
  const candidates = []
  const add = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value)
  }
  const modules = sdk.freerdpMajor === 0 ? [] : [
    `freerdp${sdk.freerdpMajor}`, `freerdp-client${sdk.freerdpMajor}`, `winpr${sdk.freerdpMajor}`
  ]
  for (const module of modules) {
    const result = spawnSync('pkg-config', ['--variable=prefix', module], { encoding: 'utf8', shell: false })
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim()) {
      add(resolve(result.stdout.trim()))
    }
  }
  return candidates.filter((candidate) => existsSync(candidate) && statSync(candidate).isDirectory())
}

function runtimeNamesFromLdd(executablePath, root) {
  if (platform !== 'win') return undefined
  const rootParent = dirname(root)
  const lddCandidates = [
    'ldd',
    join(rootParent, 'usr', 'bin', 'ldd.exe'),
    join(rootParent, 'usr', 'bin', 'ldd')
  ]
  for (const command of lddCandidates) {
    const result = spawnSync(command, [executablePath], {
      encoding: 'utf8',
      shell: false,
      env: {
        ...process.env,
        PATH: [join(root, 'bin'), join(rootParent, 'usr', 'bin'), process.env.PATH].filter(Boolean).join(';')
      }
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') continue
    const names = new Set()
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.match(/=>\s+(.+?)\s+\(/)
      if (!match) continue
      const value = match[1].trim()
      if (/^\/c\/Windows\//i.test(value) || /[\\/]Windows[\\/]System32[\\/]/i.test(value)) continue
      const name = value.replaceAll('/', '\\').split('\\').pop()
      if (name && /\.dll$/i.test(name)) names.add(name.toLowerCase())
    }
    return names
  }
  return undefined
}

function copyKnownLicenseFiles() {
  const packageNames = ['freerdp', 'freerdp3', 'freerdp2', 'winpr', 'winpr3', 'winpr2', 'openssl', 'zlib', 'libjpeg-turbo', 'libpng', 'openh264', 'gtk3', 'libgtk-3-0t64', 'libglib2.0-0t64', 'libpulse0', 'libasound2t64']
  const copied = []
  const licenseDir = join(stageDir, 'licenses')
  const findLicense = (base, name) => {
    const candidates = [
      join(base, 'share', name, 'copyright'),
      join(base, 'share', 'licenses', name, 'LICENSE'),
      join(base, 'share', 'licenses', name, 'LICENSE.md'),
      join(base, 'share', 'licenses', name, 'COPYING'),
      join(base, 'share', 'doc', name, 'copyright'),
      join(base, 'share', 'doc', name, 'LICENSE'),
      join(base, 'share', 'doc', name, 'COPYING')
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    const directory = join(base, 'share', 'licenses', name)
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return undefined
    const fallback = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(license|copying|copyright)/i.test(entry.name))
      .map((entry) => join(directory, entry.name))
      .sort((a, b) => a.localeCompare(b))
    return fallback[0]
  }
  for (const base of [...vcpkgRoots(), ...pkgConfigRoots()]) {
    for (const name of packageNames) {
      const license = findLicense(base, name)
      if (!license) continue
      mkdirSync(licenseDir, { recursive: true })
      const targetName = `${name}.txt`
      copyFileSync(license, join(licenseDir, targetName))
      copied.push(join('licenses', targetName).replaceAll('\\', '/'))
    }
  }
  // Homebrew stores upstream licenses at each formula keg's root, not in
  // share/licenses. Collect the actual redistributed dependencies' licenses.
  if (platform === 'mac') {
    const deps = spawnSync('brew', ['deps', '--installed', 'freerdp'], { encoding: 'utf8', shell: false })
    if (deps.status !== 0) throw new Error(`Cannot enumerate Homebrew FreeRDP dependencies: ${deps.stderr}`)
    for (const formula of new Set(['freerdp', ...deps.stdout.trim().split(/\s+/).filter(Boolean)])) {
      const prefix = spawnSync('brew', ['--prefix', formula], { encoding: 'utf8', shell: false })
      if (prefix.status !== 0) throw new Error(`Cannot locate Homebrew formula ${formula}`)
      const base = prefix.stdout.trim()
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isFile() || !/^(licen[cs]e|copying|copyright|notice)([._-]|$)/i.test(entry.name)) continue
        mkdirSync(licenseDir, { recursive: true })
        const name = `${formula.replaceAll('/', '_')}-${entry.name}`
        copyFileSync(join(base, entry.name), join(licenseDir, name))
        copied.push(`licenses/${name}`)
      }
    }
  }
  return [...new Set(copied)].sort((a, b) => a.localeCompare(b))
}

const runtimeFiles = [...new Set([...copySiblingRuntimeDependencies(matches[0]), ...copyOpenSslProviderModules(), ...copyUnixRuntimeDependencies()])]
const licenseFiles = copyKnownLicenseFiles()
const notice = [
  'OpenFinalShell RDP worker third-party notices',
  '',
  'The FreeRDP backend links against FreeRDP, WinPR, TLS, compression, and image/codec libraries supplied by the native build environment.',
  'Keep this file and the copied license files beside resources/rdp-worker in every release artifact.',
  '',
  `Target: ${platform}/${arch}`,
  `Runtime files: ${runtimeFiles.length > 0 ? runtimeFiles.join(', ') : '(none staged)'}`,
  `Copied license files: ${licenseFiles.length > 0 ? licenseFiles.join(', ') : '(none discovered)'}`,
  '',
  'Primary upstream projects: FreeRDP, WinPR, OpenSSL, zlib, libjpeg-turbo, libpng, OpenH264 when present.'
].join('\n')
writeFileSync(join(stageDir, thirdPartyNoticeName), `${notice}\n`, 'utf8')
writeFileSync(join(stageDir, runtimeManifestName), `${JSON.stringify({
  schema: 1,
  platform,
  arch,
  backend: requireFreerdp ? 'freerdp' : 'optional',
  freerdpMajor: sdk.freerdpMajor,
  executable: executableName,
  runtimeFiles,
  noticeFile: thirdPartyNoticeName,
  licenseFiles
}, null, 2)}\n`, 'utf8')

const rel = relative(root, staged)
console.log(`Staged RDP worker ${platform}/${arch}: ${rel} (${statSync(staged).size} bytes)`)
if (runtimeFiles.length > 0) console.log(`Staged RDP runtime files: ${runtimeFiles.join(', ')}`)
console.log(`Staged RDP notices: ${runtimeManifestName}, ${thirdPartyNoticeName}`)
