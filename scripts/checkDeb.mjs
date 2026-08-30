import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const releaseDir = join(process.cwd(), 'release')
const files = existsSync(releaseDir) ? readdirSync(releaseDir).filter((name) => name.endsWith('.deb')) : []
const arch = process.argv[2] ?? 'x64'
const debArch = { x64: 'amd64', arm64: 'arm64' }[arch]
if (!debArch) throw new Error(`Unsupported Debian target architecture: ${arch}`)
if (files.length !== 1) {
  throw new Error(`Expected exactly one .deb in release/, found ${files.length}: ${files.join(', ')}`)
}

const deb = join(releaseDir, files[0])
const field = (name) => execFileSync('dpkg-deb', ['--field', deb, name], { encoding: 'utf8' }).trim()
const contents = execFileSync('dpkg-deb', ['--contents', deb], { encoding: 'utf8' })
const pkg = execFileSync(process.execPath, ['-p', "require('./package.json').version"], { encoding: 'utf8' }).trim()

const expectedFile = `OpenFinalShell-${pkg}-debian13-${debArch}.deb`
if (files[0] !== expectedFile) throw new Error(`Unexpected artifact name: ${files[0]} (expected ${expectedFile})`)
if (field('Package') !== 'openfinalshell') throw new Error(`Unexpected Package: ${field('Package')}`)
if (field('Version') !== pkg) throw new Error(`Unexpected Version: ${field('Version')}`)
if (field('Architecture') !== debArch) throw new Error(`Unexpected Architecture: ${field('Architecture')}`)
if (field('Section') !== 'net') throw new Error(`Unexpected Section: ${field('Section')}`)
if (!field('Maintainer')) throw new Error('Debian Maintainer is empty')

const depends = field('Depends').split(',').map((item) => item.trim().split(/\s+/)[0])
const required = [
  'libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64', 'libc6', 'libcairo2',
  'libcups2t64', 'libdbus-1-3', 'libdrm2', 'libexpat1', 'libgbm1', 'libglib2.0-0t64',
  'libgtk-3-0t64', 'libnspr4', 'libnss3', 'libpango-1.0-0', 'libudev1', 'libx11-6',
  'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0',
  'libxrandr2', 'libxss1', 'libxtst6', 'libnotify4', 'xdg-utils', 'libatspi2.0-0t64',
  'libuuid1', 'libsecret-1-0'
]
for (const name of required) {
  if (!depends.includes(name)) throw new Error(`Missing Debian 13 dependency: ${name}`)
}
for (const obsolete of ['libgtk-3-0', 'libatspi2.0-0', 'libappindicator3-1']) {
  if (depends.includes(obsolete)) throw new Error(`Obsolete dependency present: ${obsolete}`)
}

for (const path of [
  './opt/OpenFinalShell/openfinalshell',
  './usr/share/applications/openfinalshell.desktop',
  './usr/share/icons/hicolor/512x512/apps/openfinalshell.png'
]) {
  if (!contents.includes(path)) throw new Error(`Package is missing ${path}`)
}
const executable = contents.split('\n').find((line) => line.includes('./opt/OpenFinalShell/openfinalshell'))
if (!executable?.startsWith('-rwx')) throw new Error('Packaged executable is not executable')

console.log(`OK ${files[0]}: openfinalshell ${pkg} ${debArch}, Debian 13 dependencies and desktop files verified`)
