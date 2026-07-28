import { describe, expect, it } from 'vitest'
import type { TaskId, TransferTask } from '@shared/types'
import {
  buildTransferView,
  etaFrom,
  rowIndexAt,
  selectTransferTotals,
  snapOf,
  type ProgressMap,
  type ProgressSnap
} from '@/features/transfers/aggregate'

/**
 * 队列界面的算术。**零 mock** —— aggregate.ts 只 import 类型，所以这一整个文件
 * 不需要碰 IPC 桩，测的就是真实现而不是"自己跟自己对"。
 */

const H = { group: 56, child: 40, single: 76 }
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

const noProgress: ProgressMap = new Map()

describe('总计：目录任务不许污染分子分母', () => {
  /**
   * 目录任务有**两个**形态：入队时 size = -1，展开后 main 把它当汇总容器（size 从 0 起累加）。
   * 判 `size > 0` 一举排除两种；判 `!== -1` 会把展开后的那种算成"大小已知的 0 字节文件"。
   */
  it('size 为 -1 与 0 的都不进 bytes，且未完成时计入 unknownCount', () => {
    const t = selectTransferTotals(
      [
        task({ size: -1 }),
        task({ size: 0 }),
        task({ size: 100, transferred: 40 }),
        task({ size: 200, transferred: 200, state: 'done' })
      ],
      noProgress
    )
    expect(t.bytes).toBe(300)
    expect(t.transferred).toBe(240)
    expect(t.unknownCount).toBe(2)
  })

  it('已完成的未知大小任务不再计入 unknownCount（否则总 ETA 永远不出现）', () => {
    const t = selectTransferTotals([task({ size: 0, state: 'done' })], noProgress)
    expect(t.unknownCount).toBe(0)
  })

  /** 一有子任务，父任务就不该再算一条"已完成" —— 否则每个目录白送一条 */
  it('有子任务的父任务不计入 totalCount/doneCount', () => {
    const parent = task({ size: -1, isGroup: true })
    // 未展开：它此刻算叶子
    expect(selectTransferTotals([parent], noProgress).totalCount).toBe(1)

    const kids = Array.from({ length: 6 }, () => task({ parentId: parent.id, size: 10 }))
    const t = selectTransferTotals([parent, ...kids], noProgress)
    expect(t.totalCount).toBe(6) // 不是 7
    expect(t.bytes).toBe(60)
  })

  it('transferred 不许超过 size（服务器报小了也不能算出 >100%）', () => {
    const t = selectTransferTotals([task({ size: 100, transferred: 250 })], noProgress)
    expect(t.transferred).toBe(100)
  })
})

describe('速度聚合与旧 StatusBar 逐字等价', () => {
  it('只累加 running，且上下行分开', () => {
    const t = selectTransferTotals(
      [
        task({ kind: 'upload', state: 'running', speedBps: 100 }),
        task({ kind: 'upload', state: 'paused', speedBps: 999 }),
        task({ kind: 'download', state: 'running', speedBps: 30 }),
        task({ kind: 'download', state: 'queued', speedBps: 777 }),
        task({ kind: 'download', state: 'done', speedBps: 555 })
      ],
      noProgress
    )
    expect(t.upSpeed).toBe(100)
    expect(t.downSpeed).toBe(30)
    expect(t.runningCount).toBe(2)
  })

  /**
   * 换实现不许改变状态栏上的数字。内联一份旧公式随机对照 —— 这是唯一的硬证据。
   * （旧公式没有分组概念，所以对照用例里不放父子关系。）
   */
  it('随机 50 组：与旧 reduce 公式完全相等', () => {
    for (let round = 0; round < 50; round++) {
      const states: Array<TransferTask['state']> = [
        'running',
        'paused',
        'queued',
        'done',
        'error',
        'canceled'
      ]
      const tasks = Array.from({ length: 20 }, (_, i) =>
        task({
          kind: (i * 7) % 2 === 0 ? 'upload' : 'download',
          state: states[(i * 5 + round) % states.length],
          speedBps: (i * 137 + round * 31) % 5000
        })
      )
      const running = tasks.filter((x) => x.state === 'running')
      const oldUp = running
        .filter((x) => x.kind === 'upload')
        .reduce((sum, x) => sum + x.speedBps, 0)
      const oldDown = running
        .filter((x) => x.kind === 'download')
        .reduce((sum, x) => sum + x.speedBps, 0)

      const t = selectTransferTotals(tasks, noProgress)
      expect(t.upSpeed).toBe(oldUp)
      expect(t.downSpeed).toBe(oldDown)
      expect(t.runningCount).toBe(running.length)
    }
  })

  it('分组任务本身的 speedBps 不计入（它不搬字节）', () => {
    const parent = task({ isGroup: true, state: 'running', speedBps: 12345, size: 0 })
    const kid = task({ parentId: parent.id, state: 'running', speedBps: 50, size: 10 })
    const t = selectTransferTotals([parent, kid], noProgress)
    expect(t.upSpeed).toBe(50)
  })
})

describe('overlay 语义', () => {
  it('有 overlay 用 overlay，没有就回落到任务自带字段', () => {
    const a = task({ transferred: 1, size: 2, speedBps: 3 })
    const snap: ProgressSnap = { transferred: 10, size: 20, speedBps: 30 }
    const progress: ProgressMap = new Map([[a.id, snap]])
    expect(snapOf(a, progress)).toBe(snap)
    expect(snapOf(a, noProgress)).toBe(a)
  })

  it('总计走 overlay（进度事件不写 tasks，不读 overlay 就永远显示 0）', () => {
    const a = task({ size: 100, transferred: 0 })
    const progress: ProgressMap = new Map([
      [a.id, { transferred: 60, size: 100, speedBps: 7 } as ProgressSnap]
    ])
    expect(selectTransferTotals([a], progress).transferred).toBe(60)
  })
})

describe('etaFrom', () => {
  it('速度为 0、大小未知都返回 null；已传完返回 0', () => {
    expect(etaFrom(100, 0, 0)).toBeNull()
    expect(etaFrom(0, 0, 10)).toBeNull()
    expect(etaFrom(-1, 0, 10)).toBeNull()
    expect(etaFrom(100, 100, 10)).toBe(0)
    expect(etaFrom(100, 120, 10)).toBe(0)
  })

  it('正常值取整', () => {
    expect(etaFrom(1000, 100, 300)).toBe(3)
  })
})

describe('行表', () => {
  it('无父任务时全是 single，按 createdAt 倒序', () => {
    const a = task({ createdAt: 1 })
    const b = task({ createdAt: 2 })
    const { rows } = buildTransferView([a, b], noProgress, new Set(), H)
    expect(rows.map((r) => r.kind)).toEqual(['single', 'single'])
    expect(rows.map((r) => r.task.id)).toEqual([b.id, a.id])
  })

  it('只有一个分组时自动展开（否则拖一个目录进来只看到一行，像没反应）', () => {
    const p = task({ isGroup: true, size: 0, createdAt: 1 })
    const kids = [task({ parentId: p.id, createdAt: 3 }), task({ parentId: p.id, createdAt: 2 })]
    const { rows } = buildTransferView([p, ...kids], noProgress, new Set(), H)
    expect(rows.map((r) => r.kind)).toEqual(['group', 'child', 'child'])
    // 组内正序：用户想看"传到第几个了"
    expect(rows.slice(1).map((r) => r.task.createdAt)).toEqual([2, 3])
  })

  it('两个以上分组时默认收起', () => {
    const p1 = task({ isGroup: true, size: 0 })
    const p2 = task({ isGroup: true, size: 0 })
    const rows = buildTransferView(
      [p1, p2, task({ parentId: p1.id }), task({ parentId: p2.id })],
      noProgress,
      new Set(),
      H
    ).rows
    expect(rows.map((r) => r.kind)).toEqual(['group', 'group'])
  })

  it('展开集合里的分组才展开', () => {
    const p1 = task({ isGroup: true, size: 0, createdAt: 10 })
    const p2 = task({ isGroup: true, size: 0, createdAt: 20 })
    const rows = buildTransferView(
      [p1, p2, task({ parentId: p1.id }), task({ parentId: p2.id })],
      noProgress,
      new Set([p1.id]),
      H
    ).rows
    expect(rows.map((r) => r.kind)).toEqual(['group', 'group', 'child'])
  })

  it('组级计数与字节来自直接子任务', () => {
    const p = task({ isGroup: true, size: 0 })
    const rows = buildTransferView(
      [
        p,
        task({ parentId: p.id, size: 100, transferred: 100, state: 'done' }),
        task({ parentId: p.id, size: 50, transferred: 25, state: 'running', speedBps: 9 }),
        task({ parentId: p.id, size: 10, state: 'error' })
      ],
      noProgress,
      new Set(),
      H
    ).rows
    const g = rows[0]
    if (g.kind !== 'group') throw new Error('第一行应该是分组')
    expect(g.group.totalCount).toBe(3)
    expect(g.group.doneCount).toBe(1)
    expect(g.group.failedCount).toBe(1)
    expect(g.group.bytes).toBe(160)
    expect(g.group.transferred).toBe(125)
    expect(g.group.speedBps).toBe(9)
    expect(g.group.state).toBe('running')
  })

  it('子任务全终态且有失败 → 组级 partial', () => {
    const p = task({ isGroup: true, size: 0 })
    const rows = buildTransferView(
      [p, task({ parentId: p.id, state: 'done' }), task({ parentId: p.id, state: 'error' })],
      noProgress,
      new Set(),
      H
    ).rows
    const g = rows[0]
    if (g.kind !== 'group') throw new Error('第一行应该是分组')
    expect(g.group.state).toBe('partial')
  })

  /** key 抖一下，传输中的行就会重新挂载，进度条动画归零 */
  it('同输入连调两次，key 完全相同', () => {
    const p = task({ isGroup: true, size: 0 })
    const all = [p, task({ parentId: p.id }), task({ parentId: p.id })]
    const a = buildTransferView(all, noProgress, new Set(), H).rows.map((r) => r.key)
    const b = buildTransferView(all, noProgress, new Set(), H).rows.map((r) => r.key)
    expect(a).toEqual(b)
    expect(new Set(a).size).toBe(a.length)
  })
})

describe('高度偏移与二分定位', () => {
  const p = task({ isGroup: true, size: 0, createdAt: 1 })
  const all = [p, task({ parentId: p.id, createdAt: 2 }), task({ parentId: p.id, createdAt: 3 })]
  const view = buildTransferView(all, noProgress, new Set(), H)

  it('offsets 严格递增，相邻差等于行高，总高对得上', () => {
    const { rows, offsets, totalHeight } = view
    expect(offsets).toHaveLength(rows.length)
    for (let i = 0; i + 1 < rows.length; i++) {
      expect(offsets[i + 1] - offsets[i]).toBe(H[rows[i].kind])
    }
    expect(totalHeight).toBe(offsets.at(-1)! + H[rows.at(-1)!.kind])
  })

  /**
   * 窗口化的经典 bug 全在这里，而它的表现是"滚到某个位置空一行" —— 肉眼未必抓得到。
   * 所以边界逐个来：正好落在某行顶端时必须返回**那一行**，不是前一行也不是后一行。
   */
  it('y 正好等于某行顶端时返回那一行', () => {
    const { offsets } = view
    for (let k = 0; k < offsets.length; k++) {
      expect(rowIndexAt(offsets, offsets[k])).toBe(k)
    }
  })

  it('行内任意位置返回该行；越界向两端收', () => {
    const { offsets, rows, totalHeight } = view
    expect(rowIndexAt(offsets, offsets[1] + 1)).toBe(1)
    expect(rowIndexAt(offsets, offsets[1] - 1)).toBe(0)
    expect(rowIndexAt(offsets, -999)).toBe(0)
    expect(rowIndexAt(offsets, totalHeight + 999)).toBe(rows.length - 1)
    expect(rowIndexAt([], 5)).toBe(0)
  })
})
