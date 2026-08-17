import { safeStorage } from 'electron'

/** Linux 的 basic_text 只是可逆编码，不是系统密钥库，不能用于保存凭据或包裹数据密钥。 */
export function secureStorageAvailable(input?: {
  platform: NodeJS.Platform
  encryptionAvailable: boolean
  backend?: ReturnType<typeof safeStorage.getSelectedStorageBackend>
}): boolean {
  const platform = input?.platform ?? process.platform
  const encryptionAvailable = input?.encryptionAvailable ?? safeStorage.isEncryptionAvailable()
  if (!encryptionAvailable) return false
  if (platform !== 'linux') return true
  const backend = input?.backend ?? safeStorage.getSelectedStorageBackend()
  return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)
}
