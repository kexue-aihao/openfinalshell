import type { ProfileId, SessionId, TermId } from '@shared/types'
import { SshConnection } from './SshConnection'
import type { ShellSession } from './ShellSession'
import { getProfile, touchProfile } from '../store/connections'
import { emit } from '../ipc/registry'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('ssh-mgr')

/**
 * sessionId → SshConnection / termId → ShellSession 注册表。
 * 所有会话状态归 main 进程；renderer 是纯视图，按 id 订阅。
 */
class SshConnectionManager {
  private readonly sessions = new Map<SessionId, SshConnection>()
  private readonly terms = new Map<TermId, ShellSession>()

  async open(profileId: ProfileId): Promise<{ sessionId: SessionId }> {
    const profile = getProfile(profileId)
    if (!profile) throw new Error('连接配置不存在')

    const conn = new SshConnection(structuredClone(profile))
    this.sessions.set(conn.sessionId, conn)
    // 终端注册的清理由 channel close → ShellSession onExit 链路完成，这里只转发状态
    conn.on('state', (state, error) => {
      emit('session:state', { sessionId: conn.sessionId, state, error })
    })

    try {
      await conn.connect()
    } catch (err) {
      this.sessions.delete(conn.sessionId)
      throw err
    }
    touchProfile(profileId)
    log.info(`session ${conn.sessionId} ready (${profile.username}@${profile.host}:${profile.port})`)
    return { sessionId: conn.sessionId }
  }

  get(sessionId: SessionId): SshConnection {
    const conn = this.sessions.get(sessionId)
    if (!conn) throw new Error('会话不存在或已关闭')
    return conn
  }

  getTerm(termId: TermId): ShellSession | undefined {
    return this.terms.get(termId)
  }

  async openShell(sessionId: SessionId, cols: number, rows: number): Promise<{ termId: TermId }> {
    const conn = this.get(sessionId)
    const shell = await conn.openShell(cols, rows, (termId, reason) => {
      this.terms.delete(termId)
      emit('term:exit', { termId, reason: reason === 'error' ? 'error' : 'closed' })
    })
    this.terms.set(shell.termId, shell)
    return { termId: shell.termId }
  }

  closeTerm(termId: TermId): void {
    const shell = this.terms.get(termId)
    if (shell) {
      this.terms.delete(termId)
      shell.close()
    }
  }

  close(sessionId: SessionId): void {
    const conn = this.sessions.get(sessionId)
    if (!conn) return
    for (const termId of conn.shells.keys()) this.terms.delete(termId)
    conn.disconnect()
    this.sessions.delete(sessionId)
  }

  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId)
  }
}

export const sshManager = new SshConnectionManager()
