import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, basename } from 'node:path'
import { machine } from 'node:os'

const execFileAsync = promisify(execFile)
const MANIFEST_LIMIT = 64 * 1024
const PACKAGE_LIMIT = 2 * 1024 * 1024 * 1024
const TRUSTED_DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const PEM = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEArbBds6RVwvHy/nodTGD9
17sV9s+YapKRAfx+QeOFMjRlV5KkzuNtR5IVDYKSUBGDMT2Fw5d8euH9sLSBSKoX
N4/VrjyhlytC9X7txf8Jxd38Jac7LIoxoSAXHtILnegm+nMDVw24bfnV61Jtlx5a
hjvL1G9dgdfN7IdP0dcSM+xIqn8Vi9VDK94jpzYocc/vruq3JU02OeoCRr8rzCxP
+22ZsSHECqf41zQW7lm4zxG26dg33UyErMBswjbnHKjgaO12wST//1nryftdfgpt
TH4ba4gHxVBtjAnZkKN0qvsns2CkIBWKV2flJ1auGJnb0ZKtnqEBx950zEdQjxzx
qGi0PC4cSEHa1CwhWQg6+518+a7pEBj6tn9p6z8Xl2gj+8X4WO55zEjE9lReySN+
8LpK2g5U3Zz1+gdYEoKQKBz7/nkgPuJhtgOHZ91r+XyRSGLkRtqmajQdh+n5T90O
UWWF9ilJoMr9jOeVYpGn5LNCtw9pxPnj6+LrjqkfFj2FAgMBAAE=
-----END PUBLIC KEY-----`

export type NativePreviewArchitecture = 'x64' | 'x86' | 'arm64'
export interface NativePreviewManifest {
  schemaVersion: 1
  version: string
  channel: 'preview' | 'stable'
  architecture: NativePreviewArchitecture
  fileName: string
  downloadUrl: string
  sha256: string
  signature: string
  bytes: number
  notesUrl?: string
}
export interface NativePreviewProgress { percent: number; received: number; total: number }
export interface NativePreviewUpgradeInfo {
  architecture: NativePreviewArchitecture
  availableVersion?: string
  installed: boolean
  installedVersion?: string
  manifestError?: string
}

/** Follow only HTTPS redirects that stay within GitHub's release download hosts. */
export async function fetchNativePreviewResponse(
  fetcher: typeof fetch,
  url: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  let current = new URL(url)
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (
      current.protocol !== 'https:' ||
      current.username ||
      current.password ||
      current.port ||
      !TRUSTED_DOWNLOAD_HOSTS.has(current.hostname)
    ) {
      throw new Error('Native preview download redirected to an untrusted host.')
    }
    const response = await fetcher(current, { ...init, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) throw new Error('Native preview download redirect is missing its destination.')
    current = new URL(location, current)
  }
  throw new Error('Native preview download used too many redirects.')
}

export function resolveNativePreviewArchitecture(host = machine()): NativePreviewArchitecture {
  const value = host.toLowerCase()
  if (value.includes('arm64') || value.includes('aarch64')) return 'arm64'
  if (value === 'x86' || value === 'i386' || value === 'i686') return 'x86'
  if (value.includes('64') || value === 'amd64' || value === 'x86_64') return 'x64'
  throw new Error(`Unsupported Windows architecture: ${host}`)
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
}

export function verifyNativePreviewManifest(value: unknown, architecture: NativePreviewArchitecture): NativePreviewManifest {
  if (!value || typeof value !== 'object') throw new Error('Native preview manifest is invalid.')
  const manifest = value as Record<string, unknown>
  if (manifest.schemaVersion !== 1 || !validVersion(manifest.version)) throw new Error('Native preview manifest schema or version is unsupported.')
  if (manifest.channel !== 'preview' && manifest.channel !== 'stable') throw new Error('Native preview channel is invalid.')
  if (manifest.architecture !== architecture) throw new Error(`Native preview package targets ${String(manifest.architecture)}, expected ${architecture}.`)
  if (typeof manifest.fileName !== 'string' || basename(manifest.fileName) !== manifest.fileName || /[\\/]/.test(manifest.fileName)) throw new Error('Native preview package filename is unsafe.')
  const displayArch = architecture === 'arm64' ? 'ARM64' : architecture
  if (manifest.fileName !== `OpenFinalShell-NativePreview-${manifest.version}-${displayArch}-Setup.exe`) throw new Error('Native preview package filename does not match its version and architecture.')
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) throw new Error('Native preview package hash is invalid.')
  if (typeof manifest.signature !== 'string' || manifest.signature.length > 4096) throw new Error('Native preview signature is invalid.')
  if (!Number.isSafeInteger(manifest.bytes) || Number(manifest.bytes) <= 0 || Number(manifest.bytes) > PACKAGE_LIMIT) throw new Error('Native preview package size is invalid.')
  if (typeof manifest.downloadUrl !== 'string') throw new Error('Native preview download URL is missing.')
  const download = new URL(manifest.downloadUrl)
  const expectedPath = `/kexue-aihao/openfinalshell/releases/download/v${manifest.version}/${manifest.fileName}`
  if (download.protocol !== 'https:' || download.hostname !== 'github.com' || download.pathname !== expectedPath || download.search || download.hash) throw new Error('Native preview download URL is not the expected GitHub release asset.')
  const signature = Buffer.from(manifest.signature, 'base64')
  if (signature.length < 128 || !verifySignature('sha256', Buffer.from(`${manifest.version}\n${manifest.channel}\n${manifest.sha256.toLowerCase()}\n`), createPublicKey(PEM), signature)) {
    throw new Error('Native preview manifest signature verification failed.')
  }
  if (manifest.notesUrl !== undefined && (typeof manifest.notesUrl !== 'string' || !/^https:\/\/github\.com\/kexue-aihao\/openfinalshell\/releases\/tag\//.test(manifest.notesUrl))) {
    throw new Error('Native preview release notes URL is invalid.')
  }
  return manifest as unknown as NativePreviewManifest
}

interface ServiceOptions {
  userDataDirectory: string
  architecture?: NativePreviewArchitecture
  manifestUrl?: string
  fetcher?: typeof fetch
  registryQuery?: () => Promise<string>
  openPath?: (path: string) => Promise<string>
  progress?: (event: NativePreviewProgress) => void
}

export class NativePreviewUpgradeService {
  private readonly architecture: NativePreviewArchitecture
  private readonly manifestUrl: string
  private readonly fetcher: typeof fetch
  private readonly registryQuery: () => Promise<string>
  private readonly openPath?: (path: string) => Promise<string>
  private readonly progress?: (event: NativePreviewProgress) => void
  private readonly outputDirectory: string
  private verified: { manifest: NativePreviewManifest; path: string } | null = null
  private busy = false

  constructor(options: ServiceOptions) {
    this.architecture = options.architecture ?? resolveNativePreviewArchitecture(process.env.PROCESSOR_ARCHITEW6432 || machine())
    this.manifestUrl = options.manifestUrl ?? `https://github.com/kexue-aihao/openfinalshell/releases/latest/download/native-update-${this.architecture}.json`
    this.fetcher = options.fetcher ?? fetch
    this.registryQuery = options.registryQuery ?? this.queryNativeInstallRegistry
    this.openPath = options.openPath
    this.progress = options.progress
    this.outputDirectory = join(options.userDataDirectory, 'native-preview-upgrade')
  }

  async getInfo(): Promise<NativePreviewUpgradeInfo> {
    const installed = await this.installedPath()
    try {
      const manifest = await this.getManifest()
      return { architecture: this.architecture, availableVersion: manifest.version, installed: Boolean(installed?.path), installedVersion: installed?.version }
    } catch (error) {
      // An offline update feed must not hide an already installed native app.
      return {
        architecture: this.architecture,
        installed: Boolean(installed?.path),
        installedVersion: installed?.version,
        manifestError: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async download(): Promise<{ path: string; version: string; architecture: NativePreviewArchitecture; bytes: number; sha256: string }> {
    if (this.busy) throw new Error('A native preview download is already in progress.')
    this.busy = true
    try {
      const manifest = await this.getManifest()
      await mkdir(this.outputDirectory, { recursive: true })
      const destination = join(this.outputDirectory, `${manifest.version}-${manifest.architecture}-${manifest.fileName}`)
      try {
        const info = await stat(destination)
        if (info.size === manifest.bytes && await this.hashFile(destination) === manifest.sha256.toLowerCase()) {
          this.verified = { manifest, path: destination }
          this.progress?.({ percent: 100, received: info.size, total: manifest.bytes })
          return { path: destination, version: manifest.version, architecture: manifest.architecture, bytes: info.size, sha256: manifest.sha256 }
        }
      } catch { /* no valid cached package */ }

      const partial = `${destination}.${process.pid}.${Date.now()}.partial`
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        const response = await fetchNativePreviewResponse(this.fetcher, manifest.downloadUrl)
        if (!response.ok || !response.body) throw new Error(`Native preview download failed (HTTP ${response.status}).`)
        const contentLength = Number(response.headers.get('content-length') ?? 0)
        if (contentLength > PACKAGE_LIMIT || (contentLength > 0 && contentLength !== manifest.bytes)) throw new Error('Native preview package size does not match its signed manifest.')
        handle = await open(partial, 'wx')
        const hash = createHash('sha256')
        let received = 0
        let lastPercent = -1
        for await (const chunkValue of response.body as unknown as AsyncIterable<Uint8Array>) {
          const chunk = Buffer.from(chunkValue)
          received += chunk.length
          if (received > manifest.bytes || received > PACKAGE_LIMIT) throw new Error('Native preview package exceeded its signed size.')
          hash.update(chunk)
          await handle.writeFile(chunk)
          const percent = Math.floor(received * 100 / manifest.bytes)
          if (percent !== lastPercent) { lastPercent = percent; this.progress?.({ percent, received, total: manifest.bytes }) }
        }
        await handle.sync()
        await handle.close(); handle = undefined
        const actualHash = hash.digest('hex')
        if (received !== manifest.bytes || actualHash !== manifest.sha256.toLowerCase()) throw new Error('Native preview package hash or size verification failed.')
        await rm(destination, { force: true })
        await rename(partial, destination)
        this.verified = { manifest, path: destination }
        this.progress?.({ percent: 100, received, total: manifest.bytes })
        return { path: destination, version: manifest.version, architecture: manifest.architecture, bytes: received, sha256: actualHash }
      } catch (error) {
        try { await handle?.close() } catch { /* ignore close failure */ }
        await rm(partial, { force: true }).catch(() => {})
        throw error
      }
    } finally { this.busy = false }
  }

  async launchInstaller(): Promise<void> {
    if (!this.verified) throw new Error('Download and verify the native preview installer first.')
    const { manifest, path } = this.verified
    const info = await stat(path)
    if (info.size !== manifest.bytes || await this.hashFile(path) !== manifest.sha256.toLowerCase()) {
      this.verified = null
      throw new Error('The downloaded native preview installer changed; download it again.')
    }
    const error = await this.open(path)
    if (error) throw new Error(error)
  }

  async openInstalled(): Promise<void> {
    const installed = await this.installedPath()
    if (!installed?.path) throw new Error('Native preview is not installed yet.')
    const error = await this.open(installed.path)
    if (error) throw new Error(error)
  }

  private async getManifest(): Promise<NativePreviewManifest> {
    const response = await fetchNativePreviewResponse(this.fetcher, this.manifestUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Native preview update feed is unavailable (HTTP ${response.status}).`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MANIFEST_LIMIT) throw new Error('Native preview update manifest is too large.')
    let parsed: unknown
    try { parsed = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Native preview update manifest is not valid JSON.') }
    return verifyNativePreviewManifest(parsed, this.architecture)
  }

  private async installedPath(): Promise<{ path: string; version?: string } | null> {
    if (process.platform !== 'win32') return null
    let raw = ''
    try { raw = await this.registryQuery() } catch { /* try the documented default location */ }
    const match = raw.match(/^\s*InstallDir\s+REG_\w+\s+(.+)$/im)
    const version = raw.match(/^\s*Version\s+REG_\w+\s+(.+)$/im)?.[1]?.trim()
    const candidate = match?.[1]?.trim() || join(process.env.LOCALAPPDATA ?? '', 'OpenFinalShell Native Preview')
    if (!candidate || !process.env.LOCALAPPDATA && !match) return null
    const executable = join(candidate, 'OpenFinalShell.App.exe')
    try { await stat(executable); return { path: executable, version } } catch { return null }
  }

  private async queryNativeInstallRegistry(): Promise<string> {
    const { stdout } = await execFileAsync('reg.exe', ['query', 'HKCU\\Software\\OpenFinalShell.NativePreview'], { windowsHide: true, timeout: 3000 })
    return stdout
  }

  private async hashFile(path: string): Promise<string> {
    const file = await open(path, 'r')
    const hash = createHash('sha256')
    try {
      const buffer = Buffer.allocUnsafe(128 * 1024)
      let position = 0
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
        if (!bytesRead) break
        position += bytesRead
        hash.update(buffer.subarray(0, bytesRead))
      }
      return hash.digest('hex')
    } finally { await file.close() }
  }

  private async open(path: string): Promise<string> {
    if (!this.openPath) throw new Error('Launching the native preview is unavailable in this environment.')
    return this.openPath(path)
  }
}
