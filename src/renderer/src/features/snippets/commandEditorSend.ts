import { COMMAND_HISTORY_MAX_CHARS } from '@shared/constants'

/**
 * 命令编辑器"发送"这一下的全部判断，提成纯函数。
 *
 * 提出来的理由与 planDraftSwap 一样：这几条判断错了不会抛异常、界面看着照常工作，
 * 只是**发到了别的会话**、**少了一个回车**、或者**把一整段脚本塞进历史**。
 * 而它们各自的正确性都能用一张表说清楚，不需要 DOM、不需要真终端。
 */

export type SendTarget = 'current' | 'all'

export interface TargetTab {
  id: string
  /** 没有 termId = 这条会话还没开出终端，发过去没有意义 */
  termId: string | null
  profileId: string
}

/**
 * 选出这一次要发给谁。
 *
 * 两条都重要：
 * - `'current'` 时只认**当前活动**的那一条，而且它必须已经有终端。
 * - `'all'` 时按 tabs 的顺序发给所有已开终端的会话 —— 顺序稳定，
 *   因为"发到所有会话"最常见的用法是同一批机器上跑同一条命令，输出要能对着看。
 */
export function resolveTargets(
  tabs: readonly TargetTab[],
  activeTabId: string | null,
  target: SendTarget
): TargetTab[] {
  if (target === 'all') return tabs.filter((t) => t.termId !== null)
  const active = tabs.find((t) => t.id === activeTabId)
  return active && active.termId !== null ? [active] : []
}

/**
 * 正文归一。**发送、进历史、保存为快捷命令三条路共用这一份** ——
 * 三处各写一遍的话，"发出去的"、"记下来的"、"存成快捷命令的"迟早不是同一段文本。
 *
 * 两件事：
 *
 * 1. **行尾统一成 `\n`**。文本框里粘进来的 Windows 文本是 CRLF，而 `\r\n` 发给
 *    行编辑器（readline）等于**一行按两次回车** —— 中间那个空行会让 `<<EOF` 这类
 *    here-doc 直接错位。
 * 2. **末尾的空白行丢掉**。用户在文本框末尾多敲一个回车是常态，而它会变成
 *    一次多余的执行（交互式 shell 里多一个提示符，`read` 里多吞一行）。
 *    中间的空行必须留着 —— 脚本里的空行是有意义的。
 */
export function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
}

/**
 * 把编辑器里的正文变成真正写进终端的那串字节。
 *
 * 归一之外只多一件事：**`autoEnter` 决定最后补不补那一个 `\n`**。
 * 不补的话正文停在命令行上等用户自己按 —— 这是"我想再看一眼再执行"那条路，必须保留。
 */
export function buildSendText(raw: string, autoEnter: boolean): string {
  const normalized = normalizeBody(raw)
  if (normalized === '') return ''
  return autoEnter ? `${normalized}\n` : normalized
}

/**
 * 这一次发送要不要记进命令历史，记什么。
 *
 * - **没有 `autoEnter` 就不记**：正文只是躺在命令行上，用户还没按回车 ——
 *   那一下由终端那侧的采集负责（见 features/terminal/commandCapture.ts）。
 * - 记的是**发出去的那一整段**（去掉末尾换行），而不是逐行拆开：用户按"发送"是一个动作，
 *   历史里也该是一条，点回来能原样再发一次。
 * - 超过上限的一律不记。这一条**必须在渲染进程这边也判一次**：store 里的 push 是乐观更新，
 *   本地先加一条、再发 IPC，而 IPC 那侧的 zod 会把超长的拒掉 ——
 *   两边判据不一致的话，列表里会出现一条"库里其实没有"的记录，重启后凭空消失。
 */
export function historyEntryFor(raw: string, autoEnter: boolean): string | null {
  if (!autoEnter) return null
  const text = normalizeBody(raw).trim()
  if (text === '') return null
  if (text.length > COMMAND_HISTORY_MAX_CHARS) return null
  return text
}
