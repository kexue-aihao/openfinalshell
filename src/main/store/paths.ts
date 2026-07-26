import { app } from 'electron'
import { join } from 'node:path'

export function configDir(): string {
  return join(app.getPath('userData'), 'config')
}

/** v0.1.0 的 JSON 配置路径；现在只在首次启动导入到 SQLite 时用到 */
export const configFile = {
  settings: (): string => join(configDir(), 'settings.json'),
  connections: (): string => join(configDir(), 'connections.json'),
  snippets: (): string => join(configDir(), 'quick-commands.json'),
  knownHosts: (): string => join(configDir(), 'known_hosts.json'),
  vault: (): string => join(configDir(), 'vault.json'),
  forwards: (): string => join(configDir(), 'forwards.json')
}
