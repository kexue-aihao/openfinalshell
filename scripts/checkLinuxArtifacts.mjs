import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const arch = process.argv[2]
const targets = process.argv.slice(3)
const artifactArch = {
  x64: { deb: 'amd64', rpm: 'x86_64', appImage: 'x86_64', flatpak: 'x86_64' },
  arm64: { deb: 'arm64', rpm: 'aarch64', appImage: 'arm64' },
  armv7l: { deb: 'armv7l', rpm: 'armv7l', appImage: 'armv7l' }
}[arch]
if (!artifactArch) {
  throw new Error('Usage: node scripts/checkLinuxArtifacts.mjs <x64|arm64|armv7l> [deb] [rpm] [appImage] [flatpak]')
}

const artifactNames = {
  deb: (version) => `OpenFinalShell-${version}-debian13-${artifactArch.deb}.deb`,
  rpm: (version) => `OpenFinalShell-${version}-linux-${artifactArch.rpm}.rpm`,
  appImage: (version) => `OpenFinalShell-${version}-linux-${artifactArch.appImage}.AppImage`,
  ...(artifactArch.flatpak
    ? { flatpak: (version) => `OpenFinalShell-${version}-linux-${artifactArch.flatpak}.flatpak` }
    : {})
}
const selectedTargets = targets.length === 0 ? Object.keys(artifactNames) : targets
for (const target of selectedTargets) {
  if (!Object.hasOwn(artifactNames, target)) {
    throw new Error(`Unknown Linux artifact target: ${target}`)
  }
}

const releaseDir = join(process.cwd(), 'release')
if (!existsSync(releaseDir)) throw new Error('release/ does not exist')

const pkg = process.env.npm_package_version
  ?? JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version
if (!pkg) throw new Error('Package version is unavailable')

const expected = selectedTargets.map((target) => artifactNames[target](pkg))
const files = new Set(readdirSync(releaseDir))
for (const artifact of expected) {
  if (!files.has(artifact)) throw new Error(`Missing Linux artifact: ${artifact}`)
}

console.log(`OK ${arch}: ${expected.join(', ')}`)
