import type { SessionId } from '@shared/types'
import { emit } from '../ipc/registry'
import { sshManager } from '../ssh/SshConnectionManager'
import { PortTrafficCollector } from './PortTrafficCollector'

/** sessionId → 按需存在的端口采集器；关闭端口标签或 SSH 会话时立刻释放。 */
class PortTrafficManager {
  private readonly collectors = new Map<SessionId, PortTrafficCollector>()

  async start(sessionId: SessionId): Promise<void> {
    const existing = this.collectors.get(sessionId)
    if (existing) {
      if (existing.state === 'running') return
      this.stop(sessionId)
    }
    const conn = sshManager.get(sessionId)
    const collector = new PortTrafficCollector(sessionId, () => conn.openMonitorChannel(), {
      onSnapshot: (snapshot) => emit('portTraffic:data', { sessionId, snapshot }),
      onState: (state, error) => emit('portTraffic:state', { sessionId, state, error })
    })
    this.collectors.set(sessionId, collector)
    try {
      await collector.start()
    } catch (err) {
      this.collectors.delete(sessionId)
      collector.stop()
      throw err
    }
  }

  async reattach(sessionId: SessionId): Promise<void> {
    await this.collectors.get(sessionId)?.reattach()
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

export const portTrafficManager = new PortTrafficManager()
