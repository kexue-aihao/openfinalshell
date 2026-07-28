import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { TaskId, TransferTask } from '@shared/types'

/**
 * 传输 store 的行为。这里测的三件事都属于"坏了不报错，只是界面变慢或数字不对"：
 *
 *  1. 状态**批**只触发一次订阅通知（合批的全部意义）。
 *  2. 进度事件绝不换 `tasks` 的引用 —— 它是所有 `useMemo([tasks])` 不被击穿的根本原因。
 *  3. `load()` 是合并语义：订阅与回包之间到达的事件不许被旧快照盖掉（真实竞态）。
 */

type Handler = (payload: unknown) => void
const handlers = new Map<string, Handler[]>()
const calls: Array<[string, unknown[]]> = []
let invokeImpl: (channel: string, ...args: unknown[]) => Promise<unknown> = async () => undefined

vi.mock('@/ipc/api', () => ({
  ofs: {
    invoke: vi.fn((channel: string, ...args: unknown[]) => {
      calls.push([channel, args])
      return invokeImpl(channel, ...args)
    }),
    send: vi.fn(),
    on: (channel: string, handler: Handler) => {
      const list = handlers.get(channel) ?? []
      list.push(handler)
      handlers.set(channel, list)
      return () => {}
    }
  }
}))

const { useTransferStore, wireTransferEvents } = await import('@/stores/useTransferStore')

function fire<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
  for (const h of handlers.get(channel) ?? []) h(payload)
}

let seq = 0
function task(over: Partial<TransferTask> = {}): TransferTask {
  seq += 1
  return {
    id: `t${seq}` as TaskId,
    sessionId: 's1',
    kind: 'upload',
    localPath: `C:\\x\\f${seq}`,
    remotePath: `/x/f${seq}`,
    size: 100,
    transferred: 0,
    state: 'running',
    speedBps: 0,
    createdAt: seq,
    ...over
  }
}

// 事件订阅只接一次（wired 有幂等闸门），所以在所有用例前接好
wireTransferEvents()

beforeEach(() => {
  calls.length = 0
  invokeImpl = async () => undefined
  useTransferStore.setState({
    tasks: [],
    progress: new Map(),
    expandedGroups: new Set(),
    drawerOpen: false
  })
})

describe('状态批', () => {
  it('一条含 3 个任务的批 → 三个都进 tasks，且只通知一次', () => {
    let notices = 0
    const off = useTransferStore.subscribe(() => {
      notices += 1
    })
    fire('transfer:states', { tasks: [task(), task(), task()] })
    off()
    expect(useTransferStore.getState().tasks).toHaveLength(3)
    expect(notices).toBe(1)
  })

  it('同 id 再来是替换不是追加，且顺序不变', () => {
    const a = task()
    const b = task()
    fire('transfer:states', { tasks: [a, b] })
    fire('transfer:states', { tasks: [{ ...a, state: 'done' }] })
    const { tasks } = useTransferStore.getState()
    expect(tasks).toHaveLength(2)
    expect(tasks[0].id).toBe(a.id)
    expect(tasks[0].state).toBe('done')
    expect(tasks[1].id).toBe(b.id)
  })

  it('空批不触发 setState（省掉无意义的重渲染）', () => {
    let notices = 0
    const off = useTransferStore.subscribe(() => {
      notices += 1
    })
    fire('transfer:states', { tasks: [] })
    off()
    expect(notices).toBe(0)
  })
})

describe('进度合流', () => {
  it('flush 前不改任何状态；flush 后只换 progress 的引用，tasks 引用不变', async () => {
    const items = [task(), task(), task(), task(), task()]
    fire('transfer:states', { tasks: items })
    const tasksRef = useTransferStore.getState().tasks
    const progressRef = useTransferStore.getState().progress

    for (const [i, item] of items.entries()) {
      fire('transfer:progress', {
        taskId: item.id,
        transferred: (i + 1) * 10,
        total: 100,
        speedBps: 5
      })
    }
    // 还没到下一帧：两个引用都没动
    expect(useTransferStore.getState().tasks).toBe(tasksRef)
    expect(useTransferStore.getState().progress).toBe(progressRef)

    await new Promise((r) => setTimeout(r, 40))

    const after = useTransferStore.getState()
    expect(after.progress).not.toBe(progressRef)
    expect(after.progress.size).toBe(5)
    expect(after.progress.get(items[2].id)?.transferred).toBe(30)
    /*
     * 这一条是整个热/冷分离的核心断言：进度事件穿过一整帧之后，tasks 仍然是同一个
     * 数组引用。它一旦变了，分组树/总进度/高度偏移那几个 useMemo 就会每帧重算。
     */
    expect(after.tasks).toBe(tasksRef)
  })

  it('同一任务连发多条，只保留最后一条（缓的是最新值）', async () => {
    const a = task()
    fire('transfer:states', { tasks: [a] })
    for (const n of [10, 20, 70]) {
      fire('transfer:progress', { taskId: a.id, transferred: n, total: 100, speedBps: 1 })
    }
    await new Promise((r) => setTimeout(r, 40))
    expect(useTransferStore.getState().progress.get(a.id)?.transferred).toBe(70)
  })
})

describe('load 是合并语义', () => {
  /**
   * 真实竞态：订阅已经建立，load 的回包在路上。这期间到达的事件如果被
   * `set({ tasks })` 整个盖掉，界面就会退回到一份更旧的快照。
   */
  it('事件里的新状态不被 load 回来的旧快照盖掉', async () => {
    const a = task({ state: 'running' })
    fire('transfer:states', { tasks: [{ ...a, state: 'done' }] })
    invokeImpl = async () => [a] // 回包里它还是 running
    await useTransferStore.getState().load()
    expect(useTransferStore.getState().tasks[0].state).toBe('done')
  })

  it('load 失败被吞掉（启动早期 main 可能还没就绪）', async () => {
    fire('transfer:states', { tasks: [task()] })
    invokeImpl = async () => {
      throw new Error('not ready')
    }
    await expect(useTransferStore.getState().load()).resolves.toBeUndefined()
    expect(useTransferStore.getState().tasks).toHaveLength(1)
  })
})

describe('其余行为', () => {
  it('enqueue 不再开抽屉（它会盖住用户刚拖放的文件列表）', async () => {
    invokeImpl = async () => ['id-1']
    expect(useTransferStore.getState().drawerOpen).toBe(false)
    await useTransferStore.getState().enqueue([
      { sessionId: 's1', kind: 'upload', localPath: 'C:\\a', remotePath: '/a' }
    ])
    expect(useTransferStore.getState().drawerOpen).toBe(false)
  })

  it('clearFinished 顺带剪掉 overlay（不然清 5000 条后 Map 里还留 5000 个死条目）', async () => {
    const done = Array.from({ length: 100 }, () => task({ state: 'done' }))
    const live = task({ state: 'running' })
    fire('transfer:states', { tasks: [...done, live] })
    useTransferStore.setState({
      progress: new Map([...done, live].map((t) => [t.id, { transferred: 1, size: 2, speedBps: 3 }]))
    })
    invokeImpl = async () => undefined
    await useTransferStore.getState().clearFinished()
    const s = useTransferStore.getState()
    expect(s.tasks).toHaveLength(1)
    expect(s.progress.size).toBe(1)
    expect(s.progress.has(live.id)).toBe(true)
  })

  it('controlAll 走一条 channel，不是循环 invoke', async () => {
    invokeImpl = async () => ({ affected: 3 })
    await useTransferStore.getState().controlAll('cancel')
    const controlCalls = calls.filter(([c]) => c.startsWith('transfer:control'))
    expect(controlCalls).toHaveLength(1)
    expect(controlCalls[0][0]).toBe('transfer:controlAll')
  })

  it('toggleGroup 幂等且换引用（引用不变 memo 不更新）', () => {
    const before = useTransferStore.getState().expandedGroups
    useTransferStore.getState().toggleGroup('g1' as TaskId)
    const after = useTransferStore.getState().expandedGroups
    expect(after).not.toBe(before)
    expect(after.has('g1' as TaskId)).toBe(true)
    useTransferStore.getState().toggleGroup('g1' as TaskId)
    expect(useTransferStore.getState().expandedGroups.has('g1' as TaskId)).toBe(false)
  })
})
