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
import { buildConnectConfig, friendlySshError } from './auth'
import { checkHostkey, fingerprintSha256, parseKeyType, trustHostkey } from './hostkeys'
import { promptBroker } from './PromptBroker'
import { ShellSession } from './ShellSession'
import { vault } from '../store/Vault'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('ssh')

/**
 * 一条 SSH 连接的状态机（一个 SessionId）。
 * M1：connecting → authenticating → ready → closed；自动重连在 M2 挂到同一状态机上。
 */
export class SshConnection extends EventEmitter {
  readonly sessionId: SessionId
  state: SessionState = 'connecting'
  private client: Client | null = null
  private intentionalClose = false
  readonly shells = new Map<TermId, ShellSession>()

  constructor(readonly profile: ConnectionProfile) {
    super()
    this.sessionId = randomUUID()
  }

  private setState(state: SessionState, error?: string): void {
    this.state = state
    this.emit('state', state, error)
  }

  async connect(): Promise<void> {
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
      this.setState('closed', msg)
      this.client = null
      throw new Error(msg)
    }

    // ready 之后的错误/断开处理
    client.on('error', (err) => {
      log.warn(`session ${this.sessionId} error after ready: ${err.message}`)
    })
    client.on('close', () => {
      const wasIntentional = this.intentionalClose
      for (const shell of this.shells.values()) shell.close()
      this.shells.clear()
      if (this.state !== 'closed') {
        this.setState('closed', wasIntentional ? undefined : '连接已断开')
      }
    })

    this.setState('ready')
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
    // 单一 password 提示且有已存密码 → 自动应答（CentOS/麒麟 kbi-only 场景用户无感）
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
      prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo }))
    }
    const reply = await promptBroker.request(this.sessionId, 'kbi', payload)
    if (!reply.ok) {
      // 用户取消：给空答案让服务器拒绝，走统一的认证失败路径
      finish(prompts.map(() => ''))
      return
    }
    finish(reply.answers ?? prompts.map(() => ''))
  }

  async openShell(cols: number, rows: number, onExit: (termId: TermId, reason: 'closed' | 'error') => void): Promise<ShellSession> {
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
      this.shells.delete(termId)
      onExit(termId, reason)
    })
    this.shells.set(termId, shell)

    if (this.profile.terminal.startupCommand) {
      shell.write(`${this.profile.terminal.startupCommand}\n`)
    }
    return shell
  }

  disconnect(): void {
    this.intentionalClose = true
    promptBroker.cancelForSession(this.sessionId)
    for (const shell of this.shells.values()) shell.close()
    this.shells.clear()
    this.client?.end()
    if (this.state !== 'closed') this.setState('closed')
  }
}
