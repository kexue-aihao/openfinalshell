import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ConnectConfig } from 'ssh2'
import type { ConnectionProfile, PasswordPromptPayload, SessionId } from '@shared/types'
import { vault } from '../store/Vault'
import { rememberPassword } from '../store/connections'
import {
  getManagedPrivateKeyMaterial,
  getPrivateKey,
  getProxy,
  updatePrivateKeySource
} from '../store/savedRefs'
import { getSettings } from '../services/settings'
import { t } from '../services/i18n'
import { expandPath } from '../utils/expandPath'
import { promptBroker } from './PromptBroker'
import { dialThroughProxy, ProxyError, type ResolvedProxy } from './proxyDial'

export { friendlySshError } from './errors'

const WIN_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

/**
 * 可移动磁盘换盘符时，按原盘符之后的相对路径尝试其它 Windows 盘符。
 * 只有指纹匹配才会接受候选，避免把同名但不同内容的私钥误用。
 */
export async function findRelocatedKeyPath(
  originalPath: string,
  fingerprint: string | undefined,
  options?: {
    platform?: NodeJS.Platform
    drives?: string[]
    read?: (path: string) => Promise<Buffer>
  }
): Promise<{ path: string; bytes: Buffer } | undefined> {
  const platform = options?.platform ?? process.platform
  if (platform !== 'win32' || !fingerprint || !/^[A-Za-z]:[\\/]/.test(originalPath)) {
    return undefined
  }
  const rest = originalPath.slice(2)
  const expected = fingerprint.toLowerCase()
  const drives = options?.drives ?? Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
  const read = options?.read ?? ((path: string) => readFile(path))
  for (const drive of drives) {
    if (drive.toLowerCase() === originalPath[0].toLowerCase()) continue
    const candidate = `${drive}:${rest}`
    try {
      const bytes = await read(candidate)
      const actual = createHash('sha256').update(bytes).digest('hex').toLowerCase()
      if (actual === expected) return { path: candidate, bytes }
    } catch {
      // 盘符未挂载、路径不存在或无权限，继续检查下一盘符。
    }
  }
  return undefined
}

/** agent 探测链：SSH_AUTH_SOCK → Windows OpenSSH 命名管道 → pageant */
export function detectAgent(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  if (process.platform === 'win32') {
    try {
      if (existsSync(WIN_OPENSSH_AGENT_PIPE)) return WIN_OPENSSH_AGENT_PIPE
    } catch {
      /* 管道探测失败继续 */
    }
    return 'pageant'
  }
  return undefined
}

/**
 * profile 的代理归属 → 要拨的代理 id；`null` = 直连。
 * 三态见 `ConnectionProfile.proxyMode`；缺省按 `proxyId ? 'custom' : 'direct'` 兜底（老数据）。
 */
export function resolveProxyId(
  profile: ConnectionProfile,
  defaultProxyId: string | null
): string | null {
  const mode = profile.proxyMode ?? (profile.proxyId ? 'custom' : 'direct')
  if (mode === 'direct') return null
  if (mode === 'custom') return profile.proxyId ?? null
  return defaultProxyId // 'follow'
}

/**
 * profile 引用的代理 → 明文形态（密码从 Vault 取）；**判定为直连就返回 null**。
 *
 * `defaultProxyId` 是全局默认代理（设置里的 `connection.defaultProxyId`），供 `'follow'` 用。
 *
 * 两处"宁可报错也不静默直连"：用户明确要求走代理（custom 指定、或 follow 且全局配了代理）时，
 * 悄悄直连可能等于暴露真实来源。所以指到一条查不到的代理（被删了、库被手工改过）
 * 与地址为空一样，都抛 `ProxyError`。
 */
export function resolveProxy(
  profile: ConnectionProfile,
  defaultProxyId: string | null
): ResolvedProxy | null {
  const proxyId = resolveProxyId(profile, defaultProxyId)
  if (!proxyId) return null
  const p = getProxy(proxyId)
  if (!p) {
    throw new ProxyError(t('err.ssh.proxyNotFound'))
  }
  if (!p.host.trim()) {
    throw new ProxyError(t('err.ssh.proxyNoHost', { name: p.name }))
  }
  return {
    type: p.type,
    host: p.host.trim(),
    port: p.port,
    username: p.username || undefined,
    password: p.passwordRef ? (vault.getSecret(p.passwordRef) ?? undefined) : undefined
  }
}

/**
 * 装配 ssh2 连接参数（认证材料部分）。
 * 密码缺失时经 PromptBroker 向用户索要一次性密码（可选记住）。
 * 配了代理则最后拨一条隧道 socket 交给 ssh2（config.sock）。
 */
export async function buildConnectConfig(
  profile: ConnectionProfile,
  sessionId: SessionId
): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    readyTimeout: profile.options.readyTimeout,
    keepaliveInterval: profile.options.keepaliveInterval,
    keepaliveCountMax: 3,
    tryKeyboard: true
  }
  // ssh2 运行时支持 compress 选项，@types/ssh2 未声明
  ;(config as ConnectConfig & { compress?: boolean }).compress = profile.options.compress

  if (profile.options.legacyAlgorithms) {
    // 追加而非替换：兼容老交换机/堡垒机（ssh-rsa/dh-group14-sha1/aes128-cbc）。
    // ssh2 运行时支持 { append } 形式，@types/ssh2 的 AlgorithmList 未覆盖该形态。
    config.algorithms = {
      kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] },
      serverHostKey: { append: ['ssh-rsa', 'ssh-dss'] },
      cipher: { append: ['aes128-cbc', 'aes256-cbc', '3des-cbc'] }
    } as unknown as ConnectConfig['algorithms']
  }

  switch (profile.auth.method) {
    case 'password': {
      let password = profile.auth.passwordRef ? vault.getSecret(profile.auth.passwordRef) : null
      if (password === null) {
        const payload: PasswordPromptPayload = { username: profile.username, host: profile.host }
        const reply = await promptBroker.request(sessionId, 'password', payload)
        if (!reply.ok || !reply.answers?.[0]) {
          throw new Error(t('err.ssh.passwordCancelled'))
        }
        password = reply.answers[0]
        if (reply.remember && vault.isAvailable()) {
          rememberPassword(profile.id, password)
        }
      }
      config.password = password
      break
    }
    case 'privateKey': {
      const keyId = profile.auth.privateKeyId
      if (!keyId) throw new Error(t('err.ssh.noPrivateKeySelected'))
      const key = getPrivateKey(keyId)
      if (!key) {
        throw new Error(t('err.ssh.privateKeyNotFound'))
      }
      // 展开只在读取时做，savedRefs 里保留用户的原始输入（~/.ssh/xxx 跨机器导入才有意义）。
      const keyPath = expandPath(key.path)
      try {
        const bytes = await readFile(keyPath)
        config.privateKey = bytes
        const fingerprint = createHash('sha256').update(bytes).digest('hex')
        // 老记录没有指纹时顺手补上；外部私钥被用户替换后也以当前文件为新来源。
        if (key.sourceFingerprint !== fingerprint) {
          updatePrivateKeySource(key.id, key.path, fingerprint)
        }
      } catch {
        const relocated = await findRelocatedKeyPath(keyPath, key.sourceFingerprint)
        if (relocated) {
          config.privateKey = relocated.bytes
          // 只更新路径和指纹；私钥材料仍留在 main/Vault，不回传 renderer。
          updatePrivateKeySource(key.id, relocated.path, key.sourceFingerprint!)
        } else {
          const managed = getManagedPrivateKeyMaterial(key)
          if (managed) {
            config.privateKey = managed
          } else {
            // 报错要指名是哪一条保存的私钥 —— 只报路径的话，用户得自己回想哪台机器用的是它
            throw new Error(t('err.ssh.privateKeyReadFail', { name: key.name, path: keyPath }))
          }
        }
      }
      if (key.passphraseRef) {
        config.passphrase = vault.getSecret(key.passphraseRef) ?? undefined
      }
      break
    }
    case 'agent': {
      const agent = detectAgent()
      if (!agent) {
        throw new Error(t('err.ssh.noAgent'))
      }
      config.agent = agent
      break
    }
  }

  // 代理拨号放最后：上面可能停在密码输入弹窗上，先拨会让代理连接白等到超时
  const proxy = resolveProxy(profile, getSettings().connection.defaultProxyId)
  if (proxy) {
    config.sock = await dialThroughProxy(proxy, { host: profile.host, port: profile.port })
  }

  return config
}

