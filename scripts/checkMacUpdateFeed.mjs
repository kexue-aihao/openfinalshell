import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import yaml from 'js-yaml'

const directory = process.argv[2] || 'release'
const arch = process.argv[3]
if (!['x64', 'arm64'].includes(arch)) throw new Error('Expected macOS architecture')
const feeds = readdirSync(directory).filter(name => name.endsWith('-mac.yml'))
if (feeds.length !== 1) throw new Error('Expected exactly one architecture-specific macOS feed')
const name = `latest-${arch}-mac.yml`
if (feeds[0] !== name) throw new Error('macOS updater channel mismatch')
const feed = yaml.load(readFileSync(join(directory, name), 'utf8'))
if (!Array.isArray(feed.files) || feed.files.length === 0) throw new Error('Missing macOS update files')
let zip = false
for (const entry of feed.files) {
  if (typeof entry.url !== 'string' || basename(entry.url) !== entry.url) throw new Error('Invalid feed file path')
  const file = join(directory, entry.url)
  if (!existsSync(file)) throw new Error('Update asset missing')
  if (createHash('sha512').update(readFileSync(file)).digest('base64') !== entry.sha512) throw new Error('Update asset checksum mismatch')
  zip ||= entry.url.endsWith('.zip')
}
if (!zip) throw new Error('macOS updater requires a ZIP asset')
console.log(`Verified ${name}`)
