import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { Client, type ClientChannel } from 'ssh2'
import type {
  ConnectionProfile,
  HostkeyPromptPayload,
  KbiPromptPayload,
  SessionId,
  SessionState,
  TermId
} from '@shared/types'
import { buildConnectConfig } from './auth'
import { friendlySshError } from './errors'
import { checkHostkey, fingerprintSha256, parseKeyType, trustHostkey } from './hostkeys'
import { promptBroker } from './PromptBroker'
import { ShellSession } from './ShellSession'
import { vault } from '../store/Vault'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('ssh')

/** 指数退避（秒）：末值重复直到 MAX_RECONNECT_ATTEMPTS 用尽 */
const BACKOFF_SEC = [1, 2, 4, 8, 15, 30]
const MAX_RECONNECT_ATTEMPTS = 10

export interface ShellExitInfo {
  termId: TermId
  reason: 'closed' | 'error' | 'reconnected'
}

/**
 * 一条 SSH 连接的状态机（一个 SessionId）。
 * connecting → authenticating → ready ⇄ reconnecting → closed
 *
 * 断线后（非用户主动）按 profile.options.autoReconnect 走指数退避重连；
 * shell 状态不可恢复，重连成功后对每个 shell 发 reconnected，由 renderer 重开。
 */
export class SshConnection extends EventEmitter {
  readonly sessionId: SessionId
  state: SessionState = 'connecting'
  private client: Client | null = null
  private intentionalClose = false
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  readonly shells = new Map<TermId, ShellSession>()

  constructor(readonly profile: ConnectionProfile) {
    super()
    this.sessionId = randomUUID()
  }

  private setState(state: SessionState, error?: string): void {
    this.state = state
    this.emit('state', state, error)
  }

  /** 首次连接：失败直接抛错给调用方（UI 显示失败原因） */
  async connect(): Promise<void> {
    await this.establish()
    this.reconnectAttempt = 0
  }

  private async establish(): Promise<void> {
    this.setState('connecting')
    let config
    try {
      config = await buildConnectConfig(this.profile, this.sessionId)
    } catch (err) {
      const msg = friendlySshError(err)
      this.setState('closed', msg)
      throw new Error(msg)
    }

    config.hostVerifier = (key: Buffer, verify: (valid: boolean) => void): void => {
      void this.verifyHostKey(key).then(verify)
    }

    const client = new Client()
    this.client = client

    client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
      void this.handleKbi(
        name,
        instructions,
        prompts.map((p) => ({ prompt: p.prompt, echo: p.echo !== false })),
        finish
      )
    })

    this.setState('authenticating')
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err)
        client.once('error', onError)
        client.once('ready', () => {
          client.removeListener('error', onError)
          resolve()
        })
        client.connect(config)
      })
    } catch (err) {
      const msg = friendlySshError(err)
      this.client = null
      this.setState('closed', msg)
      throw new Error(msg)
    }

    client.on('error', (err) => {
      log.warn(`session ${this.sessionId} error after ready: ${err.message}`)
    })
    client.on('close', () => this.onClientClosed())

    this.setState('ready')
    this.emit('reestablished')
  }

  private onClientClosed(): void {
    // 该连接上的所有 shell 通道随之失效
    for (const shell of this.shells.values()) shell.close()
    const lostTerms = [...this.shells.keys()]
    this.shells.clear()

    if (this.intentionalClose) {
      if (this.state !== 'closed') this.setState('closed')
      return
    }

    const canRetry =
      this.profile.options.autoReconnect && this.reconnectAttempt < MAX_RECONNECT_ATTEMPTS
    for (const termId of lostTerms) {
      this.emit('shell-exit', { termId, reason: canRetry ? 'reconnected' : 'closed' } as ShellExitInfo)
    }

    if (!canRetry) {
      this.setState('closed', '连接已断开')
      return
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delaySec = BACKOFF_SEC[Math.min(this.reconnectAttempt, BACKOFF_SEC.length - 1)]
    this.reconnectAttempt += 1
    this.setState(
      'reconnecting',
      `连接已断开，${delaySec} 秒后重连（第 ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} 次）`
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.intentionalClose) return
      void this.establish()
        .then(() => {
          this.reconnectAttempt = 0
        })
        .catch((err: Error) => {
          log.warn(`reconnect ${this.reconnectAttempt} failed: ${err.message}`)
          if (this.intentionalClose) return
          if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            this.setState('closed', `重连失败：${err.message}`)
          } else {
            this.scheduleReconnect()
          }
        })
    }, delaySec * 1000)
  }

  /** 用户手动重连（清零退避计数，立即尝试） */
  async reconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.intentionalClose = false
    this.reconnectAttempt = 0
    this.client?.end()
    this.client = null
    await this.establish()
  }

  private async verifyHostKey(key: Buffer): Promise<boolean> {
    const keyType = parseKeyType(key)
    const fp = fingerprintSha256(key)
    const check = checkHostkey(this.profile.host, this.profile.port, keyType, fp)
    if (check.status === 'match') return true

    const payload: HostkeyPromptPayload = {
      host: this.profile.host,
      port: this.profile.port,
      keyType,
      fingerprintSha256: `SHA256:${fp}`,
      previousFingerprint:
        check.status === 'mismatch' ? `SHA256:${check.previous.fingerprintSha256}` : undefined
    }
    const reply = await promptBroker.request(
      this.sessionId,
      check.status === 'unknown' ? 'hostkey-new' : 'hostkey-changed',
      payload
    )
    if (reply.ok && reply.remember) {
      trustHostkey(this.profile.host, this.profile.port, keyType, fp)
    }
    return reply.ok
  }

  private async handleKbi(
    name: string,
    instructions: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (answers: string[]) => void
  ): Promise<void> {
    // 单一 password 提示且有已存密码 → 自动应答（kbi-only 服务器用户无感）
    if (prompts.length === 1 && /password/i.test(prompts[0].prompt) && this.profile.auth.passwordRef) {
      const saved = vault.getSecret(this.profile.auth.passwordRef)
      if (saved !== null) {
        finish([saved])
        return
      }
    }
    if (prompts.length === 0) {
      finish([])
      return
    }
    const payload: KbiPromptPayload = {
      title: name || `${this.profile.username}@${this.profile.host}`,
      instructions,
      prompts
    }
    const reply = await promptBroker.request(this.sessionId, 'kbi', payload)
    // 用户取消：给空答案让服务器拒绝，走统一的认证失败路径
    finish(reply.ok ? (reply.answers ?? prompts.map(() => '')) : prompts.map(() => ''))
  }

  async openShell(cols: number, rows: number): Promise<ShellSession> {
    const client = this.client
    if (!client || this.state !== 'ready') throw new Error('会话未就绪')
    const termId = randomUUID()
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        { term: this.profile.terminal.termType || 'xterm-256color', cols, rows },
        (err, stream) => (err ? reject(new Error(friendlySshError(err))) : resolve(stream))
      )
    })
    const shell = new ShellSession(termId, channel, this.profile.terminal.charset || 'utf-8', (reason) => {
      // shell 自身退出（用户敲 exit）；连接断开走 onClientClosed 统一处理
      if (this.shells.delete(termId)) {
        this.emit('shell-exit', { termId, reason } as ShellExitInfo)
      }
    })
    this.shells.set(termId, shell)

    if (this.profile.terminal.startupCommand) {
      shell.write(`${this.profile.terminal.startupCommand}\n`)
    }
    return shell
  }

  disconnect(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    promptBroker.cancelForSession(this.sessionId)
    for (const shell of this.shells.values()) shell.close()
    this.shells.clear()
    this.client?.end()
    this.client = null
    if (this.state !== 'closed') this.setState('closed')
  }
}
