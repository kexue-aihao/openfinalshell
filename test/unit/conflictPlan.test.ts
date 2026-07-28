import { describe, expect, it } from 'vitest'
import type { TransferEnqueueItem } from '@shared/types'
import { effectiveAction, planConflicts } from '../../src/main/sftp/conflictPlan'

/**
 * 冲突裁决的纯逻辑。**零 mock** —— conflictPlan.ts 不碰 SFTP、fs、electron。
 *
 * 这一片的错法都是"静默做错事"（该跳过的覆盖了、该覆盖的跳过了），
 * 而那正好是集成测试最看不出来的一类：本地 fixture 的 rename 会覆盖，
 * 所以 skip/overwrite 的语义在它上面永远是绿的（见 test/integration/sftp.test.ts 的注释）。
 */

function item(remotePath: string, over: Partial<TransferEnqueueItem> = {}): TransferEnqueueItem {
  return {
    sessionId: 's1',
    kind: 'upload',
    localPath: `C:\\x\\${remotePath.split('/').pop()}`,
    remotePath,
    ...over
  }
}

describe('effectiveAction：设置怎么兜底', () => {
  /**
   * 'ask' 落到 overwrite 是**故意的**，不是漏了一支。
   * 'ask' 的含义在入口层（有冲突就弹框）；走到 worker 说明没人问过 —— 那些路径
   * （编辑器保存、命令编辑器…）今天的行为就是无条件覆盖，改成 skip 会让它们静默失效。
   */
  it("'ask' 与 'resume' 都落到 overwrite（保持既有行为）", () => {
    expect(effectiveAction(undefined, 'ask')).toBe('overwrite')
    expect(effectiveAction(undefined, 'resume')).toBe('overwrite')
  })

  it('设置里的三个真值原样生效', () => {
    expect(effectiveAction(undefined, 'overwrite')).toBe('overwrite')
    expect(effectiveAction(undefined, 'skip')).toBe('skip')
    expect(effectiveAction(undefined, 'rename')).toBe('rename')
  })

  /** retry 要复用当初用户选的那个，而不是重读可能已经被改过的设置 */
  it('任务上带的裁决优先于设置', () => {
    expect(effectiveAction('skip', 'overwrite')).toBe('skip')
    expect(effectiveAction('overwrite', 'skip')).toBe('overwrite')
    expect(effectiveAction('rename', 'ask')).toBe('rename')
  })
})

describe('planConflicts', () => {
  it('overwrite：一条都不改（这条路与改动前逐字一致）', () => {
    const items = [item('/d/a.txt'), item('/d/b.txt')]
    const r = planConflicts({
      items,
      action: 'overwrite',
      conflicts: new Set(['a.txt']),
      renames: new Map()
    })
    expect(r.items).toEqual(items)
    expect(r.skipped).toBe(0)
    expect(r.renamed).toBe(0)
  })

  /**
   * 撞名的项**仍然留在返回数组里**，只是标了 skipExisting。
   * 不是遗漏：选了 500 个、3 个撞名跳过，界面上出现 497 行而那 3 个无影无踪 ——
   * 用户会以为程序把文件吞了。
   */
  it('skip：撞名的标 skipExisting 但不从数组里丢掉', () => {
    const r = planConflicts({
      items: [item('/d/a.txt'), item('/d/b.txt')],
      action: 'skip',
      conflicts: new Set(['a.txt']),
      renames: new Map()
    })
    expect(r.items).toHaveLength(2)
    expect(r.items[0].skipExisting).toBe(true)
    expect(r.items[1].skipExisting).toBeUndefined()
    expect(r.skipped).toBe(1)
  })

  it('rename：只改撞名项的 remotePath，目录部分不动', () => {
    const r = planConflicts({
      items: [item('/deep/dir/a.txt'), item('/deep/dir/b.txt')],
      action: 'rename',
      conflicts: new Set(['a.txt']),
      renames: new Map([['a.txt', 'a (2).txt']])
    })
    expect(r.items[0].remotePath).toBe('/deep/dir/a (2).txt')
    expect(r.items[1].remotePath).toBe('/deep/dir/b.txt')
    expect(r.renamed).toBe(1)
  })

  it('rename：算不出新名时原样放过（宁可覆盖也不猜一个名字）', () => {
    const r = planConflicts({
      items: [item('/d/a.txt')],
      action: 'rename',
      conflicts: new Set(['a.txt']),
      renames: new Map()
    })
    expect(r.items[0].remotePath).toBe('/d/a.txt')
    expect(r.renamed).toBe(0)
  })

  it('没撞名的项在任何策略下都原样通过', () => {
    for (const action of ['overwrite', 'skip', 'rename'] as const) {
      const one = item('/d/fresh.txt')
      const r = planConflicts({ items: [one], action, conflicts: new Set(), renames: new Map() })
      expect(r.items[0]).toBe(one)
    }
  })

  it('根目录下的项也认得出基名', () => {
    const r = planConflicts({
      items: [item('/a.txt')],
      action: 'skip',
      conflicts: new Set(['a.txt']),
      renames: new Map()
    })
    expect(r.items[0].skipExisting).toBe(true)
  })

  it('尾随斜杠（目录项）不影响基名判定', () => {
    const r = planConflicts({
      items: [item('/d/logs/')],
      action: 'skip',
      conflicts: new Set(['logs']),
      renames: new Map()
    })
    expect(r.items[0].skipExisting).toBe(true)
  })

  it('下载方向的项不受影响（冲突裁决只管上传）', () => {
    const dl = item('/d/a.txt', { kind: 'download' })
    const r = planConflicts({
      items: [dl],
      action: 'skip',
      conflicts: new Set(['a.txt']),
      renames: new Map()
    })
    // planConflicts 是纯函数、不看 kind —— 调用方（applyConflictPlan）负责只喂上传项。
    // 这条用例把这个分工钉下来：真要改成"这里也过滤"，得先想清楚谁负责。
    expect(r.items[0].skipExisting).toBe(true)
  })
})
