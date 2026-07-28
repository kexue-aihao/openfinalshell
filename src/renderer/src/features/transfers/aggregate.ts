import type { TaskId, TransferTask } from '@shared/types'
// 只从 @shared 拿类型与常量 —— 见下面文件头注释里"零运行时依赖"那一条
import { TRANSFER_FINAL_STATES } from '@shared/constants'

/**
 * 队列界面的全部算术。
 *
 * **这个文件只 import 类型**，一个运行时依赖都没有 —— 于是它的测试零 mock 就能跑。
 * 放在 store 里是不行的：那个文件顶层 `import { ofs } from '@/ipc/api'`，为了测一段
 * 算术而挂一套 IPC mock，就是把纯逻辑测试污染成"自己跟自己对"的第一步。
 */

/**
 * 一条任务的进度快照。与 TransferTask 上那三个同名字段是同一个东西 ——
 * 分开放是为了让进度事件不去碰 tasks 数组（见 useTransferStore 的说明）。
 */
export interface ProgressSnap {
  transferred: number
  size: number
  speedBps: number
}
export type ProgressMap = ReadonlyMap<TaskId, ProgressSnap>

/**
 * 读一条任务的进度：有 overlay 用 overlay，没有就用任务自带的字段。
 *
 * 回落到任务本身是刻意的：`load()` 恢复的快照天然可用（不用回填 Map），
 * `clearFinished` 留下的孤儿 overlay 也不会造成"任务没了数字还在"。
 */
export function snapOf(task: TransferTask, progress: ProgressMap): ProgressSnap {
  return progress.get(task.id) ?? task
}

/** 剩余时间（秒）；速度为 0 或大小未知时返回 null */
export function etaFrom(size: number, transferred: number, speedBps: number): number | null {
  if (size <= 0 || speedBps <= 0) return null
  const remaining = size - transferred
  if (remaining <= 0) return 0
  return Math.round(remaining / speedBps)
}

const FINISHED = TRANSFER_FINAL_STATES

export interface TransferTotals {
  bytes: number
  transferred: number
  upSpeed: number
  downSpeed: number
  doneCount: number
  failedCount: number
  totalCount: number
  runningCount: number
  /**
   * 大小还不知道的叶子数。> 0 意味着**总量只会变大** —— 界面上要给字节总数加个 `+`，
   * 并且不显示总 ETA：基于一个已知会变大的分母算出来的剩余时间稳定偏小、
   * 还会随扫描反复跳变，比不给更糟。
   */
  unknownCount: number
}

/**
 * 一行。分组行 + 它展开后的子行，或者一条没有父亲的散件。
 * `key` 必须稳定 —— 抖一下就会让传输中的行重新挂载，进度条动画归零。
 */
export type TransferRow =
  | { kind: 'group'; key: string; task: TransferTask; group: TransferGroup; expanded: boolean }
  | { kind: 'child'; key: string; task: TransferTask }
  | { kind: 'single'; key: string; task: TransferTask }

export interface TransferGroup {
  bytes: number
  transferred: number
  speedBps: number
  doneCount: number
  failedCount: number
  totalCount: number
  unknownCount: number
  state: 'queued' | 'running' | 'paused' | 'done' | 'partial'
}

export interface RowHeights {
  group: number
  child: number
  single: number
}

export interface TransferView {
  rows: TransferRow[]
  totals: TransferTotals
  /** rows[i] 的顶部偏移，供窗口化二分定位 */
  offsets: number[]
  totalHeight: number
}

/**
 * 累加一条**叶子**任务。
 *
 * `size > 0` 而不是 `size !== -1`：目录任务有**两个**形态 —— 入队时 -1、
 * 展开后 0（main 侧把它当汇总容器）。判 > 0 一举把两种都排除，
 * 真·空文件贡献 0 也不受影响。
 */
function accumulate(
  into: {
    bytes: number
    transferred: number
    unknownCount: number
    doneCount: number
    failedCount: number
    totalCount: number
  },
  task: TransferTask,
  snap: ProgressSnap
): void {
  into.totalCount += 1
  if (snap.size > 0) {
    into.bytes += snap.size
    into.transferred += Math.min(snap.transferred, snap.size)
  } else if (!FINISHED.has(task.state)) {
    into.unknownCount += 1
  }
  if (task.state === 'done') into.doneCount += 1
  else if (task.state === 'error') into.failedCount += 1
}

/**
 * 总计。
 *
 * 只累加**叶子**（没有子任务的任务）：目录父任务一旦有子任务就不该计入
 * done/total，否则每个目录白送一条"已完成"。还没展开的目录此刻算叶子、
 * 展开后被重分类 —— 于是总数会往上跳，这是 main 渐进发现目录树的事实，
 * 只能如实呈现（靠 unknownCount 那个 `+` 告诉用户）。
 *
 * 速度只算 running，与旧 StatusBar 的规则逐字一致 —— 换实现不该改变状态栏的数字。
 */
export function selectTransferTotals(
  tasks: readonly TransferTask[],
  progress: ProgressMap
): TransferTotals {
  const parentIds = new Set<TaskId>()
  for (const t of tasks) if (t.parentId) parentIds.add(t.parentId)

  const acc = {
    bytes: 0,
    transferred: 0,
    unknownCount: 0,
    doneCount: 0,
    failedCount: 0,
    totalCount: 0
  }
  let upSpeed = 0
  let downSpeed = 0
  let runningCount = 0

  for (const task of tasks) {
    const snap = snapOf(task, progress)
    if (task.state === 'running') {
      runningCount += 1
      // 分组任务不搬字节，速度只在叶子上有意义
      if (!parentIds.has(task.id)) {
        if (task.kind === 'upload') upSpeed += snap.speedBps
        else downSpeed += snap.speedBps
      }
    }
    if (parentIds.has(task.id)) continue
    accumulate(acc, task, snap)
  }

  return { ...acc, upSpeed, downSpeed, runningCount }
}

/** 组级状态：从子任务派生，不看父任务自己的 state（它可能还在 scanning） */
function groupState(children: readonly TransferTask[], failed: number): TransferGroup['state'] {
  if (children.some((c) => c.state === 'running')) return 'running'
  if (children.some((c) => c.state === 'queued')) return 'queued'
  if (children.some((c) => c.state === 'paused')) return 'paused'
  return failed > 0 ? 'partial' : 'done'
}

/**
 * 把扁平任务表变成可渲染的行表 + 总计 + 高度偏移，**一趟走完**。
 *
 * 这个函数每帧最多跑一次（progress 走 rAF 合流、tasks 只在状态批时换引用），
 * 所以它是 O(n) 的数值遍历而不是每条事件一次。
 */
export function buildTransferView(
  tasks: readonly TransferTask[],
  progress: ProgressMap,
  expanded: ReadonlySet<TaskId>,
  rowH: RowHeights
): TransferView {
  const byParent = new Map<TaskId, TransferTask[]>()
  const parentIds = new Set<TaskId>()
  for (const t of tasks) {
    if (!t.parentId) continue
    parentIds.add(t.parentId)
    const list = byParent.get(t.parentId)
    if (list) list.push(t)
    else byParent.set(t.parentId, [t])
  }

  /*
   * 只有一个分组时默认展开：拖一个目录进来却只看到一行，会以为没反应。
   * 写成纯规则（而不是在组件里 useEffect 塞一次 toggle）才能单测。
   */
  const groupCount = [...parentIds].filter((id) => tasks.some((t) => t.id === id)).length
  const autoExpand = groupCount === 1 && expanded.size === 0

  // 顶层按 createdAt 倒序（新的在上，沿用旧行为）；组内正序（用户想看"传到第几个了"）
  const top = tasks.filter((t) => !t.parentId).sort((a, b) => b.createdAt - a.createdAt)

  const rows: TransferRow[] = []
  for (const task of top) {
    const children = byParent.get(task.id)
    if (!children || children.length === 0) {
      rows.push({ kind: 'single', key: task.id, task })
      continue
    }
    const acc = {
      bytes: 0,
      transferred: 0,
      unknownCount: 0,
      doneCount: 0,
      failedCount: 0,
      totalCount: 0
    }
    let speedBps = 0
    // 只统计直接子任务：孙任务经由它自己的父亲汇总（main 侧的 size 是逐层累加的）
    for (const child of children) {
      const snap = snapOf(child, progress)
      accumulate(acc, child, snap)
      if (child.state === 'running') speedBps += snap.speedBps
    }
    const isExpanded = autoExpand || expanded.has(task.id)
    rows.push({
      kind: 'group',
      key: task.id,
      task,
      expanded: isExpanded,
      group: {
        bytes: acc.bytes,
        transferred: acc.transferred,
        speedBps,
        doneCount: acc.doneCount,
        failedCount: acc.failedCount,
        totalCount: acc.totalCount,
        unknownCount: acc.unknownCount,
        state: groupState(children, acc.failedCount)
      }
    })
    if (!isExpanded) continue
    for (const child of [...children].sort((a, b) => a.createdAt - b.createdAt)) {
      rows.push({ kind: 'child', key: child.id, task: child })
    }
  }

  const offsets: number[] = []
  let y = 0
  for (const row of rows) {
    offsets.push(y)
    y += rowH[row.kind]
  }

  return {
    rows,
    totals: selectTransferTotals(tasks, progress),
    offsets,
    totalHeight: y
  }
}

/**
 * offsets 里第一个覆盖 y 的行下标（二分）。
 *
 * 窗口化的经典 bug 全在这个函数的边界上，而它坏掉的表现是"滚到某个位置空一行"——
 * 肉眼未必抓得到，所以边界逐个有用例。
 */
export function rowIndexAt(offsets: readonly number[], y: number): number {
  if (offsets.length === 0) return 0
  if (y <= offsets[0]) return 0
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}
