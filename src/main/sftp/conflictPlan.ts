import type { ConflictPolicy, TransferConflictAction, TransferEnqueueItem } from '@shared/types'

/**
 * 同名冲突的裁决 —— **纯函数**，没有 SFTP、没有 fs、没有 electron。
 *
 * 单独成文件是为了它能被真正测起来：这一片的错法都是"静默做错事"
 * （该跳过的覆盖了、该覆盖的跳过了），而那种错误在集成测试里恰好最难看出来
 * （见 test/integration/sftp.test.ts 里那条注释：fixture 的 rename 会覆盖，
 * 所以 skip 分支在它上面永远是绿的）。
 */

/**
 * 兜底：任务上没带裁决时按设置走。
 *
 * `'ask'` 与 `'resume'` 都落到 `'overwrite'`，这是**故意**的：
 * - `'ask'`（默认值）的含义在**入口层** —— 有冲突就弹框问。走到这里说明没人问过
 *   （比如从命令编辑器、编辑器保存那些不经过冲突框的路径入队），
 *   而那些路径今天的行为就是无条件覆盖。改成 skip 会让它们静默失效。
 * - `'resume'` 是个历史遗留值：类型里有、设置界面从来没有、逐文件路径零消费者。
 */
export function effectiveAction(
  taskAction: TransferConflictAction | undefined,
  setting: ConflictPolicy
): TransferConflictAction {
  if (taskAction) return taskAction
  if (setting === 'overwrite' || setting === 'skip' || setting === 'rename') return setting
  return 'overwrite'
}

export interface ConflictPlanInput {
  items: TransferEnqueueItem[]
  action: TransferConflictAction
  /** 远端已存在的基名（探测结果） */
  conflicts: ReadonlySet<string>
  /** 基名 → 改名后的基名（只含真的改了的） */
  renames: ReadonlyMap<string, string>
}

export interface ConflictPlanResult {
  items: TransferEnqueueItem[]
  skipped: number
  renamed: number
}

/** 远端路径的最后一段。这里只处理 `/` —— 远端路径在入队前已经规范化过 */
function baseNameOf(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx < 0 ? trimmed : trimmed.slice(idx + 1)
}

function replaceBaseName(remotePath: string, name: string): string {
  const trimmed = remotePath.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx < 0 ? name : `${trimmed.slice(0, idx + 1)}${name}`
}

/**
 * 把裁决结果落到每一条入队项上。
 *
 * `skip` 的项**仍然留在返回数组里**（只是标了 skipExisting）。不是遗漏：
 * 用户选了 500 个文件、其中 3 个撞名选了"全部跳过"，界面上出现 497 行、
 * 那 3 个无影无踪 —— 他会以为程序把文件吞了。让它们以 `skipped` 终态出现在队列里，
 * 才是把"我按你说的跳过了这 3 个"这件事说出来。
 */
export function planConflicts(input: ConflictPlanInput): ConflictPlanResult {
  const { items, action, conflicts, renames } = input
  let skipped = 0
  let renamed = 0

  const planned = items.map((item) => {
    const base = baseNameOf(item.remotePath)
    if (!conflicts.has(base)) return item
    if (action === 'skip') {
      skipped += 1
      return { ...item, skipExisting: true }
    }
    if (action === 'rename') {
      const to = renames.get(base)
      if (!to || to === base) return item
      renamed += 1
      return { ...item, remotePath: replaceBaseName(item.remotePath, to) }
    }
    // overwrite：一个字段都不用改，worker 落地那一刻按 onConflict 处置
    return item
  })

  return { items: planned, skipped, renamed }
}
