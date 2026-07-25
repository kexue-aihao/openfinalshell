import { createServer, Socket, type Server } from 'node:net'
import type { Duplex } from 'node:stream'
import type { ForwardId, ForwardRule, ForwardRuntime, SessionId } from '@shared/types'
import { emit } from '../ipc/registry'
import { sshManager } from '../ssh/SshConnectionManager'
import { buildReply, REPLY, Socks5Session } from './socks5'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('forward')

interface ActiveForward {
  rule: ForwardRule
  sessionId: SessionId
  server: Server | null
  sockets: Set<Socket>
  runtime: ForwardRuntime
}

function friendlyListenError(err: NodeJS.ErrnoException, addr: string, port: number): string {
  if (err.code === 'EADDRINUSE') return `端口已被占用：${addr}:${port}`
  if (err.code === 'EACCES') return `没有权限监听 ${addr}:${port}（1024 以下端口需要管理员）`
  if (err.code === 'EADDRNOTAVAIL') return `监听地址不可用：${addr}`
  return err.message
}

/**
 * 三型转发：
 *  local(-L)   本地 net server → client.forwardOut → 远端目标
 *  remote(-R)  远端 sshd 监听 → client 'tcp connection' 事件 → 本地目标
 *  dynamic     本地 SOCKS5 服务端 → forwardOut（目标由客户端动态给出）
 */
class ForwardManager {
  private readonly active = new Map<ForwardId, ActiveForward>()

  runtimeOf(forwardId: ForwardId): ForwardRuntime | undefined {
    return this.active.get(forwardId)?.runtime
  }

  listRuntimes(): ForwardRuntime[] {
    return [...this.active.values()].map((a) => a.runtime)
  }

  async start(rule: ForwardRule, sessionId: SessionId): Promise<void> {
    if (this.active.has(rule.id)) this.stop(rule.id)
    const entry: ActiveForward = {
      rule,
      sessionId,
      server: null,
      sockets: new Set(),
      runtime: { forwardId: rule.id, state: 'stopped', activeConns: 0, totalBytes: 0 }
    }
    this.active.set(rule.id, entry)

    try {
      if (rule.type === 'remote') await this.startRemote(entry)
      else await this.startLocalListener(entry)
      entry.runtime.state = 'active'
      entry.runtime.error = undefined
      this.publish(entry)
      log.info(`forward ${rule.id} (${rule.type}) started`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      entry.runtime.state = 'error'
      entry.runtime.error = message
      this.publish(entry)
      this.cleanup(entry)
      this.active.delete(rule.id)
      throw new Error(message)
    }
  }

  /** local 与 dynamic 都是本地监听，只是每条连接的处理不同 */
  private startLocalListener(entry: ActiveForward): Promise<void> {
    const { rule } = entry
    return new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        entry.sockets.add(socket)
        entry.runtime.activeConns = entry.sockets.size
        this.publish(entry)
        socket.on('close', () => {
          entry.sockets.delete(socket)
          entry.runtime.activeConns = entry.sockets.size
          this.publish(entry)
        })
        socket.on('error', () => socket.destroy())

        if (rule.type === 'dynamic') this.handleSocksConnection(entry, socket)
        else this.handleLocalConnection(entry, socket)
      })
      entry.server = server

      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(new Error(friendlyListenError(err, rule.bindAddr, rule.bindPort)))
      })
      server.listen(rule.bindPort, rule.bindAddr, () => {
        server.removeAllListeners('error')
        server.on('error', (err) => log.warn(`forward ${rule.id} server error: ${err.message}`))
        resolve()
      })
    })
  }

  /** -L：入站连接直接 forwardOut 到固定目标 */
  private handleLocalConnection(entry: ActiveForward, socket: Socket): void {
    const { rule } = entry
    const conn = sshManager.tryGet(entry.sessionId)
    if (!conn) {
      socket.destroy()
      return
    }
    conn.forwardOut(
      socket.remoteAddress ?? '127.0.0.1',
      socket.remotePort ?? 0,
      rule.dstHost ?? '127.0.0.1',
      rule.dstPort ?? 0,
      (err, stream) => {
        if (err || !stream) {
          log.debug(`forward ${rule.id} forwardOut failed: ${err?.message}`)
          socket.destroy()
          return
        }
        this.pipeBoth(entry, socket, stream)
      }
    )
  }

  /** dynamic：先跑 SOCKS5 协议，拿到目标后再 forwardOut */
  private handleSocksConnection(entry: ActiveForward, socket: Socket): void {
    const conn = sshManager.tryGet(entry.sessionId)
    if (!conn) {
      socket.destroy()
      return
    }
    let tunnel: Duplex | null = null
    /** 隧道建立前到达的数据（客户端流水线发送是合法的）先暂存，就绪后补发 */
    const earlyData: Buffer[] = []

    const session = new Socks5Session(
      socket,
      (target, reply) => {
        conn.forwardOut(
          socket.remoteAddress ?? '127.0.0.1',
          socket.remotePort ?? 0,
          target.host,
          target.port,
          (err, stream) => {
            if (err || !stream) {
              reply(REPLY.connectionRefused)
              socket.end()
              return
            }
            reply(REPLY.succeeded)
            tunnel = stream
            for (const buffered of earlyData) stream.write(buffered)
            earlyData.length = 0
            this.pipeBoth(entry, socket, stream, false)
          }
        )
      },
      (reason) => log.debug(`socks5 ${entry.rule.id}: ${reason}`)
    )

    socket.on('data', (chunk: Buffer) => {
      const leftover = session.feed(chunk)
      if (!leftover) return
      if (tunnel) tunnel.write(leftover)
      else earlyData.push(leftover)
    })
  }

  /** -R：远端 sshd 监听，回连本地目标 */
  private async startRemote(entry: ActiveForward): Promise<void> {
    const { rule } = entry
    const conn = sshManager.get(entry.sessionId)
    await conn.forwardIn(rule.bindAddr, rule.bindPort, (info, accept) => {
      // 按 (bindAddr, bindPort) 分发到本规则；SshConnection 已做过滤
      void info
      const channel = accept()
      const local = new Socket()
      entry.sockets.add(local)
      entry.runtime.activeConns = entry.sockets.size
      this.publish(entry)
      local.on('close', () => {
        entry.sockets.delete(local)
        entry.runtime.activeConns = entry.sockets.size
        this.publish(entry)
      })
      local.on('error', () => {
        local.destroy()
        channel.close()
      })
      local.connect(rule.dstPort ?? 0, rule.dstHost ?? '127.0.0.1', () => {
        this.pipeBoth(entry, local, channel)
      })
    })
  }

  /** 双向 pipe + 流量计数；任一端出错/关闭即销毁两端 */
  private pipeBoth(
    entry: ActiveForward,
    socket: Socket,
    stream: Duplex,
    pipeSocketToStream = true
  ): void {
    // 双向都计数：只算上行的话，"从远端下载"这类场景流量会显示成近乎 0
    const count = (chunk: Buffer): void => {
      entry.runtime.totalBytes += chunk.length
    }
    socket.on('data', count)
    stream.on('data', count)

    if (pipeSocketToStream) socket.pipe(stream)
    stream.pipe(socket)

    const destroyBoth = (): void => {
      socket.destroy()
      stream.destroy()
    }
    stream.on('close', destroyBoth)
    stream.on('error', destroyBoth)
    socket.on('close', destroyBoth)
  }

  stop(forwardId: ForwardId): void {
    const entry = this.active.get(forwardId)
    if (!entry) return
    this.cleanup(entry)
    entry.runtime.state = 'stopped'
    entry.runtime.activeConns = 0
    this.publish(entry)
    this.active.delete(forwardId)
  }

  private cleanup(entry: ActiveForward): void {
    entry.server?.close()
    entry.server = null
    for (const socket of entry.sockets) socket.destroy()
    entry.sockets.clear()
    if (entry.rule.type === 'remote') {
      sshManager.tryGet(entry.sessionId)?.unforwardIn(entry.rule.bindAddr, entry.rule.bindPort)
    }
  }

  /** 会话断开：规则转 error 待恢复 */
  onSessionLost(sessionId: SessionId): ForwardRule[] {
    const lost: ForwardRule[] = []
    for (const entry of [...this.active.values()]) {
      if (entry.sessionId !== sessionId) continue
      lost.push(entry.rule)
      this.cleanup(entry)
      entry.runtime.state = 'error'
      entry.runtime.error = '会话已断开'
      entry.runtime.activeConns = 0
      this.publish(entry)
      this.active.delete(entry.rule.id)
    }
    return lost
  }

  stopForSession(sessionId: SessionId): void {
    for (const entry of [...this.active.values()]) {
      if (entry.sessionId === sessionId) this.stop(entry.rule.id)
    }
  }

  stopAll(): void {
    for (const id of [...this.active.keys()]) this.stop(id)
  }

  private publish(entry: ActiveForward): void {
    emit('forward:state', { runtime: { ...entry.runtime } })
  }
}

export const forwardManager = new ForwardManager()
export { buildReply }
