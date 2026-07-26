import { randomUUID } from 'node:crypto'
import type { SessionId, SessionPrompt, SessionPromptKind, SessionPromptReply } from '@shared/types'
import { emit } from '../ipc/registry'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('prompt')

const PROMPT_TIMEOUT_MS = 120_000

interface PendingPrompt {
  prompt: SessionPrompt
  resolve: (reply: SessionPromptReply) => void
  timer: NodeJS.Timeout
}

/**
 * 认证/信任交互的请求-应答代理。
 * 串行队列：一次只向 renderer 弹一个对话框（多台服务器同时连接时排队）。
 */
class PromptBroker {
  private queue: PendingPrompt[] = []
  private current: PendingPrompt | null = null

  request(
    sessionId: SessionId,
    kind: SessionPromptKind,
    payload: SessionPrompt['payload']
  ): Promise<SessionPromptReply> {
    return new Promise<SessionPromptReply>((resolve) => {
      const prompt: SessionPrompt = { requestId: randomUUID(), sessionId, kind, payload }
      const pending: PendingPrompt = {
        prompt,
        resolve,
        timer: setTimeout(() => {
          log.warn(`prompt timeout: ${kind} for session ${sessionId}`)
          this.finish(prompt.requestId, { requestId: prompt.requestId, ok: false })
        }, PROMPT_TIMEOUT_MS)
      }
      this.queue.push(pending)
      this.pump()
    })
  }

  /** renderer 应答入口（session:promptReply） */
  reply(reply: SessionPromptReply): void {
    this.finish(reply.requestId, reply)
  }

  /** 会话关闭时取消其排队中的 prompt */
  cancelForSession(sessionId: SessionId): void {
    for (const p of [...this.queue, ...(this.current ? [this.current] : [])]) {
      if (p.prompt.sessionId === sessionId) {
        this.finish(p.prompt.requestId, { requestId: p.prompt.requestId, ok: false })
      }
    }
  }

  private finish(requestId: string, reply: SessionPromptReply): void {
    if (this.current?.prompt.requestId === requestId) {
      log.info(`prompt ${this.current.prompt.kind} answered: ok=${reply.ok}`)
      clearTimeout(this.current.timer)
      const { resolve } = this.current
      this.current = null
      resolve(reply)
      this.pump()
      return
    }
    const idx = this.queue.findIndex((p) => p.prompt.requestId === requestId)
    if (idx >= 0) {
      const [p] = this.queue.splice(idx, 1)
      clearTimeout(p.timer)
      p.resolve(reply)
    }
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return
    this.current = this.queue.shift()!
    // 记下"已向界面要求确认"：用户看到的是一直转圈时，日志能区分
    // "卡在等用户点确认" 与 "卡在网络握手"
    log.info(
      `prompt ${this.current.prompt.kind} → renderer (session ${this.current.prompt.sessionId}, 队列剩 ${this.queue.length})`
    )
    emit('session:prompt', this.current.prompt)
  }
}

export const promptBroker = new PromptBroker()
