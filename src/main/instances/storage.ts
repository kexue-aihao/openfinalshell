import { app } from 'electron'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { currentInstance } from '../instance'
import { metaGet, prepare } from '../store/Database'

let ownsBootstrap = false
let bootstrapFile = ''
let sharedState = ''

function cryptoState(): Record<string, unknown> | undefined {
  try {
    const state = JSON.parse(readFileSync(sharedState, 'utf8')) as { os_crypt?: Record<string, unknown> }
    return typeof state.os_crypt?.encrypted_key === 'string' && state.os_crypt.encrypted_key.length > 0 ? state.os_crypt : undefined
  } catch { return undefined }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/**
 * Windows safeStorage v10 uses the OS-protected key in Chromium Local State.
 * Seed each isolated sessionData BEFORE app ready from the same wrapped key.
 * Never copy plaintext keys, credentials or a running Chromium cache.
 * The first process alone initializes canonical Local State; siblings wait before Chromium loads it.
 */
export function configureInstanceStorage(): void {
  const root = app.getPath('userData')
  const directory = join(root, 'instances', currentInstance.instanceId)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    // Keychain/libsecret use the application identity, not Chromium Local State.
    // userData and the application name stay shared; only browser caches vary.
    app.setPath('sessionData', directory)
    return
  }
  sharedState = join(root, 'Local State')
  bootstrapFile = join(root, 'instances', 'crypto-bootstrap.json')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const crypto = cryptoState()
    if (crypto) {
      writeFileSync(join(directory, 'Local State'), JSON.stringify({ os_crypt: crypto }), { mode: 0o600 })
      app.setPath('sessionData', directory)
      return
    }
    try {
      writeFileSync(bootstrapFile, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
      ownsBootstrap = true
      if (metaGet('data_key_v1') || prepare('SELECT 1 FROM secrets LIMIT 1').get()) {
        releaseStorageBootstrap()
        throw new Error('Windows 安全存储的 Local State 丢失，无法安全解密已有配置。请恢复原用户数据目录。')
      }
      // Keep canonical sessionData for this first process. No encrypted application writes until finish below.
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(readFileSync(bootstrapFile, 'utf8')) as { pid: number }
        if (Number.isInteger(owner.pid) && !alive(owner.pid)) unlinkSync(bootstrapFile)
      } catch { /* another initializer is publishing/removing the small lock file */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  throw new Error('另一个窗口正在初始化 Windows 安全存储，请稍后重试。')
}

export async function finishStorageBootstrap(): Promise<void> {
  if (!ownsBootstrap) return
  const deadline = Date.now() + 30_000
  while (!cryptoState()) {
    if (Date.now() > deadline) throw new Error('Windows 安全存储尚未完成持久化，启动已停止以保护共享凭据。')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  releaseStorageBootstrap()
}

export function releaseStorageBootstrap(): void {
  if (!ownsBootstrap) return
  ownsBootstrap = false
  try { unlinkSync(bootstrapFile) } catch { /* best effort; stale owner is detected by PID */ }
}
