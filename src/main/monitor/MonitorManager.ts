import type { MonitorStaticInfo, SessionId } from '@shared/types'
import { MONITOR_DEFAULT_INTERVAL_MS } from '@shared/constants'
import { emit } from '../ipc/registry'
import { sshManager } from '../ssh/SshConnectionManager'
import { MonitorCollector } from './MonitorCollector'

/** sessionId → 采集器。会话关闭时一并停止。 */
class MonitorManager {
  private readonly collectors = new Map<SessionId, MonitorCollector>()

  async start(sessionId: SessionId, intervalMs = MONITOR_DEFAULT_INTERVAL_MS): Promise<MonitorStaticInfo | null> {
    const existing = this.collectors.get(sessionId)
    if (existing) {
      existing.setInterval(intervalMs)
      return null
    }
    const conn = sshManager.get(sessionId)
    const collector = new MonitorCollector(sessionId, () => conn.openMonitorChannel(), {
      onSnapshot: (snapshot) => emit('monitor:data', { sessionId, snapshot }),
      onState: (state, error) => {
        if (state === 'starting') return
        emit('monitor:state', {
          sessionId,
          state: state === 'running' ? 'running' : state === 'unsupported' ? 'unsupported' : state === 'failed' ? 'failed' : 'stopped',
          error
        })
      }
    })
    this.collectors.set(sessionId, collector)
    try {
      return await collector.start(intervalMs)
    } catch (err) {
      this.collectors.delete(sessionId)
      collector.stop()
      throw err
    }
  }

  setInterval(sessionId: SessionId, intervalMs: number): void {
    this.collectors.get(sessionId)?.setInterval(intervalMs)
  }

  stop(sessionId: SessionId): void {
    const collector = this.collectors.get(sessionId)
    if (!collector) return
    this.collectors.delete(sessionId)
    collector.stop()
  }

  stopAll(): void {
    for (const sessionId of [...this.collectors.keys()]) this.stop(sessionId)
  }
}

export const monitorManager = new MonitorManager()
