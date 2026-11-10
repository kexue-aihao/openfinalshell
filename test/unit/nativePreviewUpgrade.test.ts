import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  fetchNativePreviewResponse,
  NativePreviewUpgradeService,
  resolveNativePreviewArchitecture,
  verifyNativePreviewManifest
} from '../../src/main/services/nativePreviewUpgrade'

describe('native preview upgrade', () => {
  it.each(['Native', 'NativePreview'])('validates %s package names before checking the signature', (product) => {
    const fileName = `OpenFinalShell-${product}-0.30.52-x64-Setup.exe`
    const manifest = {
      schemaVersion: 1, version: '0.30.52', channel: 'stable', architecture: 'x64', fileName,
      downloadUrl: `https://github.com/kexue-aihao/openfinalshell/releases/download/v0.30.52/${fileName}`,
      sha256: '0'.repeat(64), signature: 'AA==', bytes: 100
    }
    expect(() => verifyNativePreviewManifest(manifest, 'x64')).toThrow(/signature verification failed/i)
    expect(() => verifyNativePreviewManifest({ ...manifest, fileName: fileName.replace('x64', 'x86') }, 'x64')).toThrow(/filename does not match/i)
    expect(() => verifyNativePreviewManifest({ ...manifest, downloadUrl: 'https://example.invalid/setup.exe' }, 'x64')).toThrow(/expected GitHub release asset/i)
  })
  it.each([
    ['AMD64', 'x64'],
    ['x86', 'x86'],
    ['ARM64', 'arm64'],
    ['aarch64', 'arm64']
  ] as const)('maps Windows host architecture %s to %s', (host, expected) => {
    expect(resolveNativePreviewArchitecture(host)).toBe(expected)
  })

  it('follows the signed release manifest redirect only through trusted HTTPS hosts', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(init?.redirect).toBe('manual')
      if (url.hostname === 'github.com') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/native-update-x64.json' }
        })
      }
      return new Response('{"schemaVersion":1}')
    }) as unknown as typeof fetch

    const response = await fetchNativePreviewResponse(
      fetcher,
      'https://github.com/kexue-aihao/openfinalshell/releases/latest/download/native-update-x64.json',
      { cache: 'no-store' }
    )

    expect(await response.text()).toBe('{"schemaVersion":1}')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects a redirect to an untrusted or insecure host before requesting it', async () => {
    const fetcher = vi.fn(async (): Promise<Response> => new Response(null, {
      status: 302,
      headers: { location: 'https://example.invalid/package.exe' }
    })) as unknown as typeof fetch

    await expect(fetchNativePreviewResponse(fetcher, 'https://github.com/release')).rejects.toThrow(/untrusted host/i)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(fetchNativePreviewResponse(fetcher, 'http://github.com/release')).rejects.toThrow(/untrusted host/i)
  })

  it('rejects a manifest targeting an architecture other than this host', () => {
    expect(() => verifyNativePreviewManifest({
      schemaVersion: 1,
      version: '1.2.3',
      channel: 'preview',
      architecture: 'arm64',
      fileName: 'OpenFinalShell-NativePreview-1.2.3-ARM64-Setup.exe',
      downloadUrl: 'https://github.com/kexue-aihao/openfinalshell/releases/download/v1.2.3/OpenFinalShell-NativePreview-1.2.3-ARM64-Setup.exe',
      sha256: '0'.repeat(64),
      signature: 'AA==',
      bytes: 100
    }, 'x64')).toThrow(/targets arm64, expected x64/i)
  })

  it('still reports an installed native app when the release feed is offline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ofs-native-preview-info-'))
    try {
      await writeFile(join(directory, 'OpenFinalShell.App.exe'), 'test')
      const service = new NativePreviewUpgradeService({
        userDataDirectory: directory,
        architecture: 'x64',
        registryQuery: async () => `InstallDir    REG_SZ    ${directory}\nVersion    REG_SZ    0.30.33`,
        fetcher: async () => { throw new Error('offline') }
      })

      await expect(service.getInfo()).resolves.toMatchObject({
        architecture: 'x64',
        installed: true,
        installedVersion: '0.30.33',
        manifestError: 'offline'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
