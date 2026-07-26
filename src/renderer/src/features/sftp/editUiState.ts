import type { EventMap } from '@shared/ipc'
import type { EditId, RemoteEditEntry } from '@shared/types'

/**
 * 远端编辑在**界面侧**的那点账：哪几条在等写回结果、哪几条已经报过"已写回"、
 * 正在编辑的列表长什么样。
 *
 * 为什么从 SftpPane 里拎出来单独一个模块：这几条判断错了不会抛异常，只会静默走偏，
 * 而它们又全都藏在 JSX 里（渲染进程的测试跑在 node 环境，没法把组件挂起来）。
 * 拎成纯函数之后 test/renderer/sftpEditUi.test.ts 能直接对着它跑时序。
 *
 * 具体是哪个坑（v0.1.3 的缺陷 1）：旧写法判"存上了没有"只看一个 Set 里有没有这条编辑 ——
 * 远端被第三方改过 → Ctrl+S → uploading（进 Set）→ conflict（**没**从 Set 里删）→ 冲突框弹出；
 * 用户在编辑器里 Ctrl+Z 撤销再存一次，main 走"内容没变"的短路分支直接回 editing，
 * 界面于是弹出"已写回远端：app.conf"——**远端此刻一个字节都没写**。
 */

/** 与 EventMap 保持同一个来源，别在这里重抄一遍字段 */
export type EditStateEvent = EventMap['sftp:editState']

export interface EditUiBook {
  /** 见过 uploading、还在等这一趟写回结果的编辑 */
  awaiting: Set<EditId>
  /**
   * 已经报过"已写回"的那个 savedAt。判据是**这个数变没变**，不是"awaiting 里有它"——
   * savedAt 由 main 在内容确实落到远端之后才推进，是唯一靠得住的实据。
   * 值可以是 undefined（这条编辑从打开到现在一次都没存成过）。
   */
  reported: Map<EditId, number | undefined>
}

export function createEditUiBook(): EditUiBook {
  return { awaiting: new Set(), reported: new Map() }
}

/** 收到一条 editState 之后界面该做的事。一次只可能有一件 */
export type EditUiAction =
  /** 停下来问用户：远端被改过 / 服务器不支持原子替换 —— 出口是"仍然覆盖"或"停止编辑" */
  | { kind: 'askOverwrite'; blocked: boolean }
  /** 停下来问用户：写回失败 —— 出口是"重试"（**保留**冲突检测）或"停止编辑" */
  | { kind: 'askRetry' }
  /** 回到 editing 且我们在等结果：去查 savedAt 变没变，变了才配说"已写回" */
  | { kind: 'verifySaved' }
  /** 这条编辑结束了：把它在账本里的痕迹一起销掉 */
  | { kind: 'forget' }
  | { kind: 'none' }

/**
 * 记账并给出动作。会就地改 book —— 它是挂在 ref 上的可变账本，不是 React state。
 */
export function onEditState(book: EditUiBook, ev: EditStateEvent): EditUiAction {
  switch (ev.state) {
    case 'downloading':
      return { kind: 'none' }
    case 'uploading':
      book.awaiting.add(ev.editId)
      return { kind: 'none' }
    case 'conflict':
    case 'blocked':
      // 必须从 awaiting 里清掉：这两个状态下远端一个字节都没写，
      // 留着它就是上面那条注释里"凭空的已写回远端"。
      book.awaiting.delete(ev.editId)
      return { kind: 'askOverwrite', blocked: ev.state === 'blocked' }
    case 'shrink':
      /**
       * 截断闸门。与 conflict/blocked 一样"远端一个字节都没写"，所以同样要从
       * "在等写回结果"里清掉。（今天这一句其实清不到东西：闸门拦在 setState('uploading')
       * 之前，awaiting 里根本没进过它 —— 摆在这里是为了哪天闸门挪到 uploading 之后
       * 也不会悄悄漏出一条假的"已写回远端"。）
       *
       * 动作给 none，确认框由 SftpPane 按状态自己分岔：shrink 的标题、说明（要带远端
       * 实数）、默认按钮与 conflict 差得远，而 askOverwrite 只带一个 blocked 布尔 ——
       * 把它撑成三态就要改这里的全部调用方与用例，收益只是把一个 if 搬个家。
       */
      book.awaiting.delete(ev.editId)
      return { kind: 'none' }
    case 'error':
      // 同上。error 的出口是重试（保留冲突检测），不是"仍然覆盖"——
      // 一次网络抖动不该把用户推上无条件覆盖别人改动的路。
      book.awaiting.delete(ev.editId)
      return { kind: 'askRetry' }
    case 'editing':
      // 打开时的 downloading→editing 不在 awaiting 里，不该报"已保存"
      return book.awaiting.delete(ev.editId) ? { kind: 'verifySaved' } : { kind: 'none' }
    case 'closed':
      book.awaiting.delete(ev.editId)
      book.reported.delete(ev.editId)
      return { kind: 'forget' }
  }
}

/**
 * 这一趟真的写到远端了吗？只认 savedAt 变新这一件事。
 *
 * 首次见到某条编辑时 rememberEdits 会 seed 一次（哪怕值是 undefined），
 * 所以"undefined → 有值"也算变新。完全没 seed 过的编辑第一次带着 savedAt 冒出来，
 * 那也确实是刚存上的 —— 一样算。
 */
export function savedIsNew(
  book: EditUiBook,
  editId: EditId,
  savedAt: number | undefined
): boolean {
  if (savedAt === undefined) return false
  if (book.reported.has(editId) && book.reported.get(editId) === savedAt) return false
  book.reported.set(editId, savedAt)
  return true
}

/**
 * 把 editList 的全量快照记进账本。
 * 只给**没见过**的编辑 seed —— 覆盖已知值会把 savedIsNew 的实据抹掉。
 * 顺手把列表里已经没有的编辑清掉，免得账本随会话越开越长。
 */
export function rememberEdits(book: EditUiBook, list: readonly RemoteEditEntry[]): void {
  const live = new Set(list.map((e) => e.id))
  for (const e of list) {
    if (!book.reported.has(e.id)) book.reported.set(e.id, e.savedAt)
  }
  for (const id of [...book.reported.keys()]) if (!live.has(id)) book.reported.delete(id)
  for (const id of [...book.awaiting]) if (!live.has(id)) book.awaiting.delete(id)
}

/**
 * "正在编辑"列表的增量更新。
 *
 * editState 事件刻意只带刷一行所需的字段（见 EventMap 的说明），**没有** size / savedAt ——
 * 所以这里只改 state/message/eolWarning，那两个数得回头拉一次 editList。
 *
 * 没见过的 editId 一律**不凭事件造行**：造出来的行缺 localPath，
 * "在文件夹中显示"会拿着空字符串去调 app:openPath。等紧随其后的 editList 把它补进来。
 * 内容没变化时返回原数组本身 —— 让 setEdits 走 zustand/React 的同引用短路，不白刷一帧。
 */
export function applyEditEvent(list: RemoteEditEntry[], ev: EditStateEvent): RemoteEditEntry[] {
  const idx = list.findIndex((e) => e.id === ev.editId)
  if (ev.state === 'closed') return idx < 0 ? list : list.filter((e) => e.id !== ev.editId)
  if (idx < 0) return list
  const next = [...list]
  next[idx] = {
    ...next[idx],
    state: ev.state,
    // main 侧的 message 在 EventMap 那边按状态拆成了 error / warning，这里拼回去
    message: ev.error ?? ev.warning,
    eolWarning: ev.eolWarning
  }
  return next
}
