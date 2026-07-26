import type { ForwardRule, ProfileId, SessionId, TermId } from '@shared/types'
import { SshConnection, type ShellExitInfo } from './SshConnection'
import type { ShellSession } from './ShellSession'
import { getProfile, touchProfile } from '../store/connections'
import { emit } from '../ipc/registry'
import { transferQueue } from '../sftp/TransferQueue'
import { clearProbeCache } from '../sftp/packTransfer'
/**
 * 静态 import 不成环：反向那条依赖（RemoteEditManager 要用 sshManager 取 SFTP 通道）
 * 是**动态** import 的，理由写在它 defaultDeps 的注释里。所以这里可以照常静态引。
 */
import { remoteEditManager } from '../sftp/RemoteEditManager'
import { monitorManager } from '../monitor/MonitorManager'
import { forwardManager } from '../forward/ForwardManager'
import { autoStartRules } from '../store/forwards'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('ssh-mgr')

/**
 * sessionId → SshConnection / termId → ShellSession 注册表。
 * 所有会话状态归 main 进程；renderer 是纯视图，按 id 订阅。
 */
class SshConnectionManager {
  private readonly sessions = new Map<SessionId, SshConnection>()
  private readonly terms = new Map<TermId, ShellSession>()
  /** 断线时保存该会话活跃过的转发规则，重连成功后重建 */
  private readonly pendingForwards = new Map<SessionId, ForwardRule[]>()

  async open(profileId: ProfileId): Promise<{ sessionId: SessionId }> {
    const profile = getProfile(profileId)
    if (!profile) throw new Error('连接配置不存在')

    // 进门就记一行：此前只在 ready 之后才写日志，卡在握手/等待确认时日志里一片空白，
    // 事后完全无从判断停在了哪一步
    log.info(`opening session ${profile.username}@${profile.host}:${profile.port} (${profile.name})`)
    const conn = new SshConnection(structuredClone(profile))
    this.sessions.set(conn.sessionId, conn)

    conn.on('state', (state, error) => {
      emit('session:state', { sessionId: conn.sessionId, state, error })
      // 断线：转发规则转 error 待恢复（重连成功后由 reestablished 重建）
      if (state === 'reconnecting' || state === 'closed') {
        const lost = forwardManager.onSessionLost(conn.sessionId)
        if (lost.length > 0) this.pendingForwards.set(conn.sessionId, lost)
      }
    })

    // 重连成功 → 先接回监控通道，再恢复该会话此前活跃的转发规则
    conn.on('reestablished', () => {
      void monitorManager.reattach(conn.sessionId).catch((err: Error) => {
        log.warn(`restore monitor failed: ${err.message}`)
      })
      const pending = this.pendingForwards.get(conn.sessionId)
      if (!pending || pending.length === 0) return
      this.pendingForwards.delete(conn.sessionId)
      for (const rule of pending) {
        void forwardManager.start(rule, conn.sessionId).catch((err: Error) => {
          log.warn(`restore forward ${rule.id} failed: ${err.message}`)
        })
      }
    })
    conn.on('shell-exit', ({ termId, reason }: ShellExitInfo) => {
      this.terms.delete(termId)
      emit('term:exit', { termId, reason })
    })

    try {
      await conn.connect()
    } catch (err) {
      this.sessions.delete(conn.sessionId)
      throw err
    }
    touchProfile(profileId)
    log.info(`session ${conn.sessionId} ready (${profile.username}@${profile.host}:${profile.port})`)

    // autoStart 的转发规则随连接自动启动（失败只记日志，不影响会话可用）
    for (const rule of autoStartRules(profileId)) {
      void forwardManager.start(rule, conn.sessionId).catch((err: Error) => {
        log.warn(`autoStart forward ${rule.label || rule.id} failed: ${err.message}`)
      })
    }
    return { sessionId: conn.sessionId }
  }

  get(sessionId: SessionId): SshConnection {
    const conn = this.sessions.get(sessionId)
    if (!conn) throw new Error('会话不存在或已关闭')
    return conn
  }

  /** 不抛异常版本（热路径/清理逻辑用） */
  tryGet(sessionId: SessionId): SshConnection | undefined {
    return this.sessions.get(sessionId)
  }

  getTerm(termId: TermId): ShellSession | undefined {
    return this.terms.get(termId)
  }

  async openShell(sessionId: SessionId, cols: number, rows: number): Promise<{ termId: TermId }> {
    const shell = await this.get(sessionId).openShell(cols, rows)
    this.terms.set(shell.termId, shell)
    return { termId: shell.termId }
  }

  async reconnect(sessionId: SessionId): Promise<void> {
    await this.get(sessionId).reconnect()
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
    transferQueue.cancelForSession(sessionId)
    /**
     * 会话没了，这个会话下的远端编辑也就没有意义了：watcher 还挂着，此后每次存盘只会报错，
     * 而临时目录里那份**明文副本**（可能是 .env / id_rsa）还留在 %TEMP% 里。
     * best-effort：stopBySession 是 async（要删本地临时目录），而 close 是同步接口 ——
     * 删不掉目录（Windows 上编辑器还占着句柄）不该拖住会话关闭。它幂等，可重复调。
     */
    void remoteEditManager.stopBySession(sessionId)
    // 打包探测缓存里存着这台机器的 tar 风味与 TMPDIR —— 换一台机器（同一个 sessionId 复用不会
    // 发生，但重连会）就该重探一次，留着只会在换机后按旧结论决策
    clearProbeCache(sessionId)
    monitorManager.stop(sessionId)
    forwardManager.stopForSession(sessionId)
    this.pendingForwards.delete(sessionId)
    for (const termId of conn.shells.keys()) this.terms.delete(termId)
    conn.disconnect()
    this.sessions.delete(sessionId)
  }

  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId)
  }
}

export const sshManager = new SshConnectionManager()
