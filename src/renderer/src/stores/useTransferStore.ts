import { create } from 'zustand'
import type { TaskId, TransferEnqueueItem, TransferTask } from '@shared/types'
import { TRANSFER_FINAL_STATES } from '@shared/constants'
import { ofs } from '@/ipc/api'
// 进度快照的类型与读法都归 aggregate.ts（它只 import 类型，测试零 mock）
import type { ProgressMap, ProgressSnap } from '@/features/transfers/aggregate'

interface TransferStore {
  /**
   * 冷数据：只有 transfer:states / load / clearFinished 会换它的引用。
   *
   * 这条纪律是队列界面能撑住上千条任务的**根本原因**：所有
   * `useMemo(..., [tasks])`（分组树、总进度、行高偏移）都不会被每秒十几次的
   * 进度事件击穿。以前每条进度事件都 `tasks.map(...)` 复制整个数组。
   */
  tasks: TransferTask[]
  /** 热数据：每帧最多换一次引用（rAF 合流） */
  progress: ProgressMap
  /** 哪些分组是展开的。瞬态，不持久化 */
  expandedGroups: ReadonlySet<TaskId>
  toggleGroup: (id: TaskId) => void
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  load: () => Promise<void>
  enqueue: (items: TransferEnqueueItem[]) => Promise<TaskId[]>
  control: (taskId: TaskId, op: 'pause' | 'resume' | 'cancel' | 'retry') => Promise<void>
  controlAll: (op: 'pause' | 'resume' | 'cancel') => Promise<void>
  clearFinished: () => Promise<void>
}

/** 终态集合只有 @shared/constants 那一份（见它的注释：以前散在 12 处） */
const FINISHED = TRANSFER_FINAL_STATES

export const useTransferStore = create<TransferStore>((set) => ({
  tasks: [],
  progress: new Map(),
  expandedGroups: new Set(),
  drawerOpen: false,

  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),

  toggleGroup: (id) =>
    set((s) => {
      const next = new Set(s.expandedGroups)
      if (!next.delete(id)) next.add(id)
      return { expandedGroups: next }
    }),

  /**
   * 拉一次队列快照。**只补不覆盖**（insertOnly）。
   *
   * 订阅在这之前就建立了，所以此刻 store 里已有的条目一定来自比这个回包**更新**的
   * 事件 —— 覆盖它就是把界面退回旧状态。这是真实竞态：不光 `set({tasks})` 会整个
   * 盖掉，逐条 upsert 也会把那一条改回去。删除权只在 clearFinished 手里。
   *
   * ⚠️ 所以这条路**只适合启动时那一次**。日后要加"手动刷新队列"，得另走一条
   * 覆盖语义的路径，别复用它。
   *
   * 修的是"重开/刷新窗口后队列列表是空的" —— 这个方法此前是死代码，全仓零调用点。
   * 注意队列在 main 侧是纯内存的，所以它恢复的是"窗口重开"，不是"应用重开"。
   */
  load: async () => {
    try {
      upsertTasks(await ofs.invoke('transfer:list'), 'insertOnly')
    } catch {
      // 启动早期 main 可能还没就绪；队列为空不是错误状态
    }
  },

  /*
   * 刻意**不**开抽屉。批量上传时那个 300px 抽屉正好盖住用户刚拖放的文件列表，
   * 而他此刻要看的是列表（落地后会自动刷新）。发现性由活动栏徽标与状态栏那条
   * 可点的速度承接。
   */
  enqueue: async (items) => await ofs.invoke('transfer:enqueue', items),

  control: async (taskId, op) => {
    await ofs.invoke('transfer:control', { taskId, op })
  },

  /*
   * 整个队列一次。**不循环调 control** —— 500 个子任务就是 500 次 invoke，
   * 每次过一遍 zod + 结构化克隆，界面明显卡住，而那正是用户会报"取消没反应"的形状。
   */
  controlAll: async (op) => {
    await ofs.invoke('transfer:controlAll', { op })
  },

  clearFinished: async () => {
    await ofs.invoke('transfer:clearFinished')
    set((s) => {
      const tasks = s.tasks.filter((t) => !FINISHED.has(t.state))
      // overlay 也要跟着剪，否则清掉 5000 条后 Map 里还留着 5000 个死条目
      const progress = new Map<TaskId, ProgressSnap>()
      for (const t of tasks) {
        const snap = s.progress.get(t.id)
        if (snap) progress.set(t.id, snap)
      }
      return { tasks, progress }
    })
  }
}))

let wired = false

/** 进度事件缓冲：事件处理 O(1)，每帧最多一次 setState */
const pendingProgress = new Map<TaskId, ProgressSnap>()
let progressFlushScheduled = false

/** vitest 是 node 环境，没有 requestAnimationFrame */
const scheduleFrame = (cb: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb)
  else setTimeout(cb, 16)
}

function flushProgress(): void {
  progressFlushScheduled = false
  if (pendingProgress.size === 0) return
  const patch = new Map(pendingProgress)
  pendingProgress.clear()
  useTransferStore.setState((s) => {
    const progress = new Map(s.progress)
    for (const [id, snap] of patch) progress.set(id, snap)
    return { progress }
  })
}

/** transfer:states / transfer:progress → store */
export function wireTransferEvents(): void {
  if (wired) return
  wired = true

  ofs.on('transfer:states', ({ tasks }) => {
    upsertTasks(tasks)
  })

  ofs.on('transfer:progress', ({ taskId, transferred, total, speedBps }) => {
    pendingProgress.set(taskId, { transferred, size: total, speedBps })
    if (progressFlushScheduled) return
    progressFlushScheduled = true
    scheduleFrame(flushProgress)
  })
}

/**
 * 按 id 整批 upsert：一次 setState、一次订阅通知。
 *
 * 索引表每批重建而不是常驻：state 批是每秒几次的量级，重建可以忽略，而常驻索引
 * 要在 upsert / load / clearFinished 三处同步 —— 三个漏点换不来什么。
 * （此前是逐条 findIndex，5000 条排队事件就是 O(n²)。）
 */
function upsertTasks(
  incoming: readonly TransferTask[],
  mode: 'replace' | 'insertOnly' = 'replace'
): void {
  if (incoming.length === 0) return
  useTransferStore.setState((s) => {
    const at = new Map<TaskId, number>()
    for (let i = 0; i < s.tasks.length; i++) at.set(s.tasks[i].id, i)
    const tasks = s.tasks.slice()
    let changed = false
    for (const task of incoming) {
      const idx = at.get(task.id)
      if (idx === undefined) {
        at.set(task.id, tasks.length)
        tasks.push(task)
        changed = true
      } else if (mode === 'replace') {
        tasks[idx] = task
        changed = true
      }
    }
    // 一条都没变就别换引用（insertOnly 下这是常态）
    return changed ? { tasks } : {}
  })
}
