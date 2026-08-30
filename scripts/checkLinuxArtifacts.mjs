import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const arch = process.argv[2]
const artifactArch = {
  x64: { deb: 'amd64', rpm: 'x86_64', appImage: 'x86_64', flatpak: 'x86_64' },
  arm64: { deb: 'arm64', rpm: 'aarch64', appImage: 'arm_aarch64', flatpak: 'aarch64' }
}[arch]
if (!artifactArch) {
  throw new Error('Usage: node scripts/checkLinuxArtifacts.mjs <x64|arm64>')
}

const releaseDir = join(process.cwd(), 'release')
if (!existsSync(releaseDir)) throw new Error('release/ does not exist')

const pkg = process.env.npm_package_version
  ?? process.argv[3]
if (!pkg) throw new Error('Package version is unavailable')

const expected = [
  `OpenFinalShell-${pkg}-debian13-${artifactArch.deb}.deb`,
  `OpenFinalShell-${pkg}-linux-${artifactArch.rpm}.rpm`,
  `OpenFinalShell-${pkg}-linux-${artifactArch.appImage}.AppImage`,
  `OpenFinalShell-${pkg}-linux-${artifactArch.flatpak}.flatpak`
]
const files = new Set(readdirSync(releaseDir))
for (const artifact of expected) {
  if (!files.has(artifact)) throw new Error(`Missing Linux artifact: ${artifact}`)
}

console.log(`OK ${arch}: ${expected.join(', ')}`)
