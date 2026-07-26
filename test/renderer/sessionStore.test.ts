import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventMap } from '@shared/ipc'

/**
 * 会话 tab 的状态机（renderer 侧）。
 * 重点是"首次连上"与"重新建连"必须区分开 —— 二者在 main 侧都是 session:state=ready，
 * 分不清就会在每次新建会话时打出"—— 连接已恢复 ——"分隔线。
 */

type Handler = (payload: unknown) => void
const handlers = new Map<string, Handler[]>()

/** 每个用例可替换的 invoke 实现：要模拟"事件先到、session:open 后 resolve"的真实时序 */
let invokeImpl: (channel: string, ...args: unknown[]) => Promise<unknown> = async () => ({
  sessionId: 'sid-1'
})

vi.mock('@/ipc/api', () => ({
  ofs: {
    invoke: vi.fn((channel: string, ...args: unknown[]) => invokeImpl(channel, ...args)),
    send: vi.fn(),
    on: (channel: string, handler: Handler) => {
      const list = handlers.get(channel) ?? []
      list.push(handler)
      handlers.set(channel, list)
      return () => {}
    }
  }
}))

const { useSessionStore, wireSessionEvents } = await import('@/stores/useSessionStore')
type SessionTab = ReturnType<typeof useSessionStore.getState>['tabs'][number]

function fire<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
  for (const h of handlers.get(channel) ?? []) h(payload)
}

/** 直接塞一个已连上的 tab，绕过 openForProfile 的 IPC */
function seedTab(overrides: Record<string, unknown> = {}): string {
  const id = 'tab-1'
  useSessionStore.setState({
    tabs: [
      {
        id,
        profileId: 'p1',
        sessionId: 'sid-1',
        termId: null,
        title: 'srv',
        state: 'connecting',
        sftpOpen: false,
        monitorOpen: false,
        shellEpoch: 0,
        ...overrides
      }
    ],
    activeTabId: id
  })
  return id
}

function tab(): NonNullable<ReturnType<typeof useSessionStore.getState>['tabs'][number]> {
  return useSessionStore.getState().tabs[0]
}

beforeEach(() => {
  useSessionStore.setState({ tabs: [], activeTabId: null })
  invokeImpl = async () => ({ sessionId: 'sid-1' })
  wireSessionEvents()
})

const PROFILE = {
  id: 'p1',
  name: 'srv',
  groupId: null,
  host: 'h',
  port: 22,
  username: 'root',
  auth: { method: 'password' as const },
  terminal: { charset: 'utf-8', termType: 'xterm' },
  options: {
    keepaliveInterval: 15000,
    readyTimeout: 20000,
    legacyAlgorithms: false,
    autoReconnect: true,
    monitorEnabled: true,
    compress: false
  },
  createdAt: 1,
  updatedAt: 1
}

/**
 * 真实时序：主进程先把 connecting/authenticating/ready 发出来，session:open 之后才 resolve。
 * 此时 tab 的 sessionId 还是 null —— 事件按 id 匹配会全部落空。
 *
 * 这一组是回归护栏：之前的用例都用 seedTab() 预置好 sessionId，把这个时序绕过去了，
 * 于是"主进程连上了、界面永远停在正在连接"这个 bug 一路漏到了发布版本里。
 */
describe('开连期间的状态事件（tab 还不知道自己的 sessionId）', () => {
  it('连上后 tab 变 ready，而不是卡在 connecting', async () => {
    invokeImpl = async (channel) => {
      if (channel !== 'session:open') return undefined
      // resolve 之前就把事件发出去，跟主进程的真实顺序一致
      fire('session:state', { sessionId: 'sid-9', state: 'connecting' })
      fire('session:state', { sessionId: 'sid-9', state: 'authenticating' })
      fire('session:state', { sessionId: 'sid-9', state: 'ready' })
      return { sessionId: 'sid-9' }
    }
    await useSessionStore.getState().openForProfile(PROFILE)

    expect(tab().sessionId).toBe('sid-9')
    expect(tab().state).toBe('ready') // ← 卡在 connecting 就是终端永远不开
    expect(tab().everReady).toBe(true)
    expect(tab().shellEpoch).toBe(0) // 首连不打"连接已恢复"分隔线
  })

  it('开连过程中又掉线：认领时用真实的最新状态，不硬写 ready', async () => {
    invokeImpl = async (channel) => {
      if (channel !== 'session:open') return undefined
      fire('session:state', { sessionId: 'sid-8', state: 'ready' })
      fire('session:state', { sessionId: 'sid-8', state: 'reconnecting', error: '断开，1 秒后重连' })
      return { sessionId: 'sid-8' }
    }
    await useSessionStore.getState().openForProfile(PROFILE)

    expect(tab().state).toBe('reconnecting')
    expect(tab().error).toBe('断开，1 秒后重连')
    expect(tab().everReady).toBeFalsy()
  })

  it('认领后的事件照常按 sessionId 生效（重连仍会递增 epoch）', async () => {
    invokeImpl = async (channel) => {
      if (channel !== 'session:open') return undefined
      fire('session:state', { sessionId: 'sid-7', state: 'ready' })
      return { sessionId: 'sid-7' }
    }
    await useSessionStore.getState().openForProfile(PROFILE)
    useSessionStore.getState().bindTerm(tab().id, 'term-7')

    fire('term:exit', { termId: 'term-7', reason: 'reconnected' })
    fire('session:state', { sessionId: 'sid-7', state: 'ready' })
    expect(tab().shellEpoch).toBe(1)
  })

  it('别的会话的残留状态不会串到新 tab 上', async () => {
    // 一个没人认领的会话先留下状态
    fire('session:state', { sessionId: 'sid-other', state: 'closed', error: '不该被别人捡走' })
    invokeImpl = async (channel) => {
      if (channel !== 'session:open') return undefined
      fire('session:state', { sessionId: 'sid-6', state: 'ready' })
      return { sessionId: 'sid-6' }
    }
    await useSessionStore.getState().openForProfile(PROFILE)
    expect(tab().state).toBe('ready')
    expect(tab().error).toBeUndefined()
  })
})

describe('session:state → tab', () => {
  it('首次连上不算"恢复"：shellEpoch 保持 0（否则每次新建会话都会打恢复分隔线）', () => {
    seedTab()
    fire('session:state', { sessionId: 'sid-1', state: 'ready' })
    expect(tab().state).toBe('ready')
    expect(tab().shellEpoch).toBe(0)
    expect(tab().everReady).toBe(true)
  })

  it('重新建连才递增 shellEpoch，让终端重开并打恢复分隔线', () => {
    seedTab()
    fire('session:state', { sessionId: 'sid-1', state: 'ready' })
    useSessionStore.getState().bindTerm('tab-1', 'term-1')

    // 掉线：main 先发 term:exit(reconnected) 清掉 termId，再发状态
    fire('term:exit', { termId: 'term-1', reason: 'reconnected' })
    expect(tab().termId).toBeNull()
    fire('session:state', { sessionId: 'sid-1', state: 'reconnecting', error: '断开，1 秒后重连' })
    fire('session:state', { sessionId: 'sid-1', state: 'ready' })

    expect(tab().shellEpoch).toBe(1)
    expect(tab().state).toBe('ready')
  })

  it('终端还在（termId 未清）时不重复递增 epoch', () => {
    seedTab()
    fire('session:state', { sessionId: 'sid-1', state: 'ready' })
    useSessionStore.getState().bindTerm('tab-1', 'term-1')
    fire('session:state', { sessionId: 'sid-1', state: 'ready' })
    expect(tab().shellEpoch).toBe(0)
  })

  it('用户敲 exit（reason=closed）时标记会话结束，而不是当成待重连', () => {
    seedTab()
    fire('session:state', { sessionId: 'sid-1', state: 'ready' })
    useSessionStore.getState().bindTerm('tab-1', 'term-1')
    fire('term:exit', { termId: 'term-1', reason: 'closed' })
    expect(tab().state).toBe('closed')
    expect(tab().termId).toBeNull()
  })

  it('事件按 sessionId 定向，不串到别的 tab', () => {
    seedTab()
    useSessionStore.setState((s: { tabs: SessionTab[] }) => ({
      tabs: [...s.tabs, { ...s.tabs[0], id: 'tab-2', sessionId: 'sid-2' }]
    }))
    fire('session:state', { sessionId: 'sid-2', state: 'ready' })
    expect(useSessionStore.getState().tabs[0].state).toBe('connecting')
    expect(useSessionStore.getState().tabs[1].state).toBe('ready')
  })
})
