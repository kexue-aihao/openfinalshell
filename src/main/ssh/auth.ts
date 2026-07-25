import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ConnectConfig } from 'ssh2'
import type { ConnectionProfile, PasswordPromptPayload, SessionId } from '@shared/types'
import { vault } from '../store/Vault'
import { rememberPassword } from '../store/connections'
import { promptBroker } from './PromptBroker'
import { dialThroughProxy, ProxyError, type ResolvedProxy } from './proxyDial'

export { friendlySshError } from './errors'

const WIN_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

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

/** profile 上的代理配置 → 明文形态（密码从 Vault 取）；直连返回 null */
export function resolveProxy(profile: ConnectionProfile): ResolvedProxy | null {
  const p = profile.proxy
  if (!p || p.type === 'none') return null
  // 宁可报错也不静默直连 —— 用户明确要求走代理时，直连可能等于暴露真实来源
  if (!p.host.trim()) {
    throw new ProxyError('已启用代理但未填写代理地址，请在连接设置的"代理"里补全')
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
          throw new Error('已取消输入密码')
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
      const keyPath = profile.auth.privateKeyPath
      if (!keyPath) throw new Error('未指定私钥文件')
      try {
        config.privateKey = await readFile(keyPath)
      } catch {
        throw new Error(`无法读取私钥文件：${keyPath}`)
      }
      if (profile.auth.passphraseRef) {
        config.passphrase = vault.getSecret(profile.auth.passphraseRef) ?? undefined
      }
      break
    }
    case 'agent': {
      const agent = detectAgent()
      if (!agent) {
        throw new Error('未检测到 SSH agent（请启用 ssh-agent 服务或设置 SSH_AUTH_SOCK）')
      }
      config.agent = agent
      break
    }
  }

  // 代理拨号放最后：上面可能停在密码输入弹窗上，先拨会让代理连接白等到超时
  const proxy = resolveProxy(profile)
  if (proxy) {
    config.sock = await dialThroughProxy(proxy, { host: profile.host, port: profile.port })
  }

  return config
}

