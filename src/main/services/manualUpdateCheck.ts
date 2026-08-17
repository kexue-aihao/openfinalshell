import { net } from 'electron'
import { isNewerRelease } from './updateGate'

const LATEST_RELEASE_API = 'https://api.github.com/repos/kexue-aihao/openfinalshell/releases/latest'
const MAX_RESPONSE_BYTES = 256 * 1024

export interface ManualUpdateResult {
  available: boolean
  version?: string
}

export async function checkLatestRelease(current: string): Promise<ManualUpdateResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await net.fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_RESPONSE_BYTES) throw new Error('GitHub Releases response is too large')
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('GitHub Releases response is too large')
    const tag = (JSON.parse(text) as { tag_name?: unknown }).tag_name
    if (typeof tag !== 'string') throw new Error('GitHub Releases response has no tag_name')
    return isNewerRelease(current, tag)
      ? { available: true, version: tag.replace(/^v/, '') }
      : { available: false }
  } finally {
    clearTimeout(timeout)
  }
}
