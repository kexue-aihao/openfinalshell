import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(options: { arch?: string; extension?: string; checksum?: string; missing?: boolean; url?: string; duplicate?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ofs-mac-feed-'))
  directories.push(directory)
  const url = options.url ?? `OpenFinalShell-0.30.23-arm64.${options.extension ?? 'zip'}`
  const asset = Buffer.from('test update asset')
  if (!options.missing && !options.url) writeFileSync(join(directory, url), asset)
  const feed = JSON.stringify({ files: [{ url, sha512: options.checksum ?? createHash('sha512').update(asset).digest('base64') }] })
  writeFileSync(join(directory, `latest-${options.arch ?? 'arm64'}-mac.yml`), feed)
  if (options.duplicate) writeFileSync(join(directory, 'latest-x64-mac.yml'), feed)
  return directory
}

function check(directory: string) {
  return spawnSync(process.execPath, [resolve('scripts/checkMacUpdateFeed.mjs'), directory, 'arm64'], { encoding: 'utf8' })
}

describe('signed macOS update feed gate', () => {
  it('accepts the architecture channel with a verified ZIP asset', () => {
    const result = check(fixture())
    expect(result.status, result.stderr).toBe(0)
  })

  it.each([
    [{ arch: 'x64' }, 'channel mismatch'],
    [{ duplicate: true }, 'exactly one'],
    [{ extension: 'dmg' }, 'requires a ZIP'],
    [{ checksum: 'incorrect' }, 'checksum mismatch'],
    [{ missing: true }, 'asset missing'],
    [{ url: '../outside.zip' }, 'Invalid feed file path']
  ] as const)('rejects invalid release metadata %j', (options, message) => {
    const result = check(fixture(options))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(message)
  })
})
