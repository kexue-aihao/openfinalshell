import { app } from 'electron'
import { join } from 'node:path'

export function configDir(): string {
  return join(app.getPath('userData'), 'config')
}

export const configFile = {
  settings: (): string => join(configDir(), 'settings.json'),
  connections: (): string => join(configDir(), 'connections.json'),
  snippets: (): string => join(configDir(), 'quick-commands.json'),
  knownHosts: (): string => join(configDir(), 'known_hosts.json'),
  vault: (): string => join(configDir(), 'vault.json')
}
