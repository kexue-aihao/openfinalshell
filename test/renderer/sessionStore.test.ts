import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventMap } from '@shared/ipc'

/**
 * 会话 tab 的状态机（renderer 侧）。
 * 重点是"首次连上"与"重新建连"必须区分开 —— 二者在 main 侧都是 session:state=ready，
 * 分不清就会在每次新建会话时打出"—— 连接已恢复 ——"分隔线。
 */

type Handler = (payload: unknown) => void
const handlers = new Map<string, Handler[]>()

vi.mock('@/ipc/api', () => ({
  ofs: {
    invoke: vi.fn(async () => ({ sessionId: 'sid-1' })),
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
  wireSessionEvents()
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
