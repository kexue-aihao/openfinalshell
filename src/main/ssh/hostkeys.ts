import type { KnownHostEntry } from '@shared/types'
import { JsonFileStore } from '../store/ConfigStore'
import { configFile } from '../store/paths'

export { fingerprintSha256, parseKeyType } from './keyUtils'

interface KnownHostsFile {
  version: number
  /** "host:port:keyType" → entry（同主机多 key 类型算不同记录，避免误报变更） */
  entries: Record<string, KnownHostEntry>
}

let store: JsonFileStore<KnownHostsFile> | null = null

function khStore(): JsonFileStore<KnownHostsFile> {
  if (!store) {
    store = new JsonFileStore<KnownHostsFile>(configFile.knownHosts(), () => ({
      version: 1,
      entries: {}
    }))
  }
  return store
}

export type HostkeyCheck =
  | { status: 'match' }
  | { status: 'unknown' }
  | { status: 'mismatch'; previous: KnownHostEntry }

export function checkHostkey(host: string, port: number, keyType: string, fp: string): HostkeyCheck {
  const entry = khStore().data.entries[`${host}:${port}:${keyType}`]
  if (!entry) return { status: 'unknown' }
  if (entry.fingerprintSha256 === fp) return { status: 'match' }
  return { status: 'mismatch', previous: entry }
}

export function trustHostkey(host: string, port: number, keyType: string, fp: string): void {
  khStore().update((d) => {
    d.entries[`${host}:${port}:${keyType}`] = {
      keyType,
      fingerprintSha256: fp,
      addedAt: Date.now()
    }
  })
}

export async function flushKnownHosts(): Promise<void> {
  await khStore().flush()
}
