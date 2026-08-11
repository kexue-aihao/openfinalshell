import type { OfsApi } from '@shared/ipc'

/**
 * 可编程的 window.ofs 替身（组件测试用）。
 *
 * 与 renderer 里那份 createMockOfs 的分工不同：那份是"UI 调试时给个能看的假数据"，
 * 这份是**测试的控制面** —— 每条 invoke 的回包时机由测试握着（deferred），
 * 这样才能摆出「两个 readdir 并发在飞、后发的先回」这类时序，那正是组件测试
 * 存在的理由（grep 护栏读不出运行时时序，已经漏过两个真 bug）。
 *
 * 安装时机在 setup.ts：必须早于 `@/ipc/api` 被 import —— 那个模块在**模块求值时**
 * 把 window.ofs 捕获进模块常量，晚一步就只能拿到它的 DEV mock。
 */

type AnyHandler = (payload: unknown) => unknown

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeOfs {
  private handlers = new Map<string, AnyHandler>()
  private listeners = new Map<string, Set<(payload: unknown) => void>>()
  /** 全部 invoke 调用的流水（含 channel 与入参），断言"发过什么"用 */
  invokes: Array<{ channel: string; payload: unknown }> = []
  /** 全部 send 调用的流水 */
  sends: Array<{ channel: string; payload: unknown }> = []

  /** 给某条 channel 装处理器；未注册的 channel 被 invoke 时直接 reject（测试要显式声明依赖） */
  handle(channel: string, fn: AnyHandler): void {
    this.handlers.set(channel, fn)
  }

  invoke(channel: string, payload?: unknown): Promise<unknown> {
    this.invokes.push({ channel, payload })
    const handler = this.handlers.get(channel)
    if (!handler) {
      return Promise.reject(new Error(`fakeOfs: 未注册的 invoke channel「${channel}」`))
    }
    // 统一异步化：真 IPC 永远不会同步回包，同步 resolve 会造出真实环境不存在的时序
    return Promise.resolve().then(() => handler(payload))
  }

  send(channel: string, payload: unknown): void {
    this.sends.push({ channel, payload })
  }

  on(channel: string, cb: (payload: unknown) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }

  /** 模拟 main → renderer 事件 */
  emit(channel: string, payload: unknown): void {
    for (const cb of this.listeners.get(channel) ?? []) cb(payload)
  }

  getPathForFile(): string {
    return ''
  }

  /** 每条用例开始前清场（处理器、流水、事件订阅全清） */
  reset(): void {
    this.handlers.clear()
    this.listeners.clear()
    this.invokes = []
    this.sends = []
  }
}

export const fakeOfs = new FakeOfs()

export function installFakeOfs(): void {
  ;(window as unknown as { ofs: OfsApi }).ofs = fakeOfs as unknown as OfsApi
}
