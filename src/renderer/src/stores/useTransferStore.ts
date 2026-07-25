import { create } from 'zustand'
import type { TaskId, TransferEnqueueItem, TransferTask } from '@shared/types'
import { ofs } from '@/ipc/api'

interface TransferStore {
  tasks: TransferTask[]
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  load: () => Promise<void>
  enqueue: (items: TransferEnqueueItem[]) => Promise<TaskId[]>
  control: (taskId: TaskId, op: 'pause' | 'resume' | 'cancel' | 'retry') => Promise<void>
  clearFinished: () => Promise<void>
  /** 进行中的任务数，用于活动栏角标 */
  activeCount: () => number
}

const FINISHED = new Set(['done', 'error', 'canceled'])

export const useTransferStore = create<TransferStore>((set, get) => ({
  tasks: [],
  drawerOpen: false,

  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),

  load: async () => {
    const tasks = await ofs.invoke('transfer:list')
    set({ tasks })
  },

  enqueue: async (items) => {
    const ids = await ofs.invoke('transfer:enqueue', items)
    set({ drawerOpen: true })
    return ids
  },

  control: async (taskId, op) => {
    await ofs.invoke('transfer:control', { taskId, op })
  },

  clearFinished: async () => {
    await ofs.invoke('transfer:clearFinished')
    set((s) => ({ tasks: s.tasks.filter((t) => !FINISHED.has(t.state)) }))
  },

  activeCount: () => get().tasks.filter((t) => t.state === 'running' || t.state === 'queued').length
}))

let wired = false

/** transfer:state / transfer:progress → store（进度事件已在 main 侧 200ms 节流） */
export function wireTransferEvents(): void {
  if (wired) return
  wired = true

  ofs.on('transfer:state', ({ task }) => {
    set_task(task)
  })

  ofs.on('transfer:progress', ({ taskId, transferred, total, speedBps }) => {
    useTransferStore.setState((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, transferred, size: total, speedBps } : t
      )
    }))
  })
}

function set_task(task: TransferTask): void {
  useTransferStore.setState((s) => {
    const idx = s.tasks.findIndex((t) => t.id === task.id)
    if (idx < 0) return { tasks: [...s.tasks, task] }
    const tasks = [...s.tasks]
    tasks[idx] = task
    return { tasks }
  })
}

/** 剩余时间估算（秒）；速度为 0 或大小未知时返回 null */
export function etaSeconds(task: TransferTask): number | null {
  if (task.size <= 0 || task.speedBps <= 0) return null
  const remaining = task.size - task.transferred
  if (remaining <= 0) return 0
  return Math.round(remaining / task.speedBps)
}
