/**
 * 换文件时那份"要不要留住草稿"的判断。**纯函数，不碰 CodeMirror 也不碰 DOM。**
 *
 * 提出来是因为它是整片里最容易静默丢数据的一段：只有一个 EditorView，切标签时如果
 * 无条件 `setState(按新内容建一份)`，那么"改了 A → 切到 B → 切回 A"就会把 A 的
 * 未保存改动扔掉 —— 不报错、不提示，用户回到 A 只看到内容变回去了。
 *
 * 而这段判断在渲染进程里没法直接测（CodeMirror 要真 DOM，这套测试跑在 node 里没有），
 * 所以把决策与副作用分开：这里只回答"该做哪一种"，CodeEditor 负责照着做。
 */

export type DraftSwap =
  /** 什么都不用动，只把脏标记清掉。刚存成的那一下就是这个 */
  | { kind: 'keep' }
  /** 按传进来的 text 建一份新的。草稿会被丢掉，所以调用方必须先问过用户 */
  | { kind: 'rebuild' }
  /** 恢复这个文件自己的暂存：草稿、撤销历史、选区、折叠状态全回来 */
  | { kind: 'restore' }

export interface DraftSwapInput {
  /** 当前 view 里装的是哪个文件（首次挂载为 null） */
  prevKey: string | null
  /** 要切到哪个文件 */
  fileKey: string
  /** store 里那份"上一次读到 / 存成的"正文 */
  text: string
  /** view 里此刻的实际内容 */
  currentDoc: string
  /** 这个 fileKey 有没有暂存过 state */
  hasStash: boolean
  /** 那份暂存当初是按哪个 text 建的。没暂存则 undefined */
  stashBase: string | undefined
}

export function planDraftSwap(input: DraftSwapInput): DraftSwap {
  const { prevKey, fileKey, text, currentDoc, hasStash, stashBase } = input

  if (prevKey === fileKey) {
    /**
     * 同一个文件，`text` 变了（重新加载、换编码、或者刚存成）。
     *
     * doc 已经等于新 text 的那种情况是"刚存成"：**不重建**。重建会白丢撤销历史，
     * 而用户刚保存完最可能想做的事就是"撤销刚才那步再看看"。
     */
    return currentDoc === text ? { kind: 'keep' } : { kind: 'rebuild' }
  }

  /**
   * 换到另一个文件。有暂存、且那份暂存正是按当前这个 text 建的 → 恢复它。
   *
   * `stashBase !== text` 时必须重建：说明这个文件在别处被重新读过（或存过），
   * 暂存里那份草稿是对着一份已经不存在的内容改的，恢复它等于把旧内容写回去。
   */
  return hasStash && stashBase === text ? { kind: 'restore' } : { kind: 'rebuild' }
}
