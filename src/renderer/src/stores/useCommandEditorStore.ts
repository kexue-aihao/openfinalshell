import { create } from 'zustand'
import type { SendTarget } from '@/features/snippets/commandEditorSend'

/**
 * 命令编辑器的草稿与选项。
 *
 * **刻意只活在内存里**，不落库也不进 settings：
 *
 * - 进 settings 就会跟着「导出应用数据」走，而这里躺的是随手写的运维命令，
 *   跟导出文件（要发给同事、要换机）不是一类东西；
 * - 落一张自己的表要顺带回答"多久清一次、要不要多份草稿"这些问题，
 *   而这一格的用途是"临时拼一段、发出去"。真值得留下的那些有「保存为快捷命令」。
 *
 * 代价说清楚：**重启应用草稿就没了**。这一条写在这里，也写在 README 里。
 */
interface CommandEditorStore {
  open: boolean
  /** 编辑器正文。整段发送，不逐行拆 */
  text: string
  target: SendTarget
  /** 末尾补一个回车（= 真的执行）。关掉则正文停在命令行上等用户自己按 */
  autoEnter: boolean
  /** 发送前把 {{host}} / {{user}} / {{port}} 按目标会话展开 */
  expandVars: boolean
  setOpen: (open: boolean) => void
  setText: (text: string) => void
  setTarget: (target: SendTarget) => void
  setAutoEnter: (autoEnter: boolean) => void
  setExpandVars: (expandVars: boolean) => void
}

export const useCommandEditorStore = create<CommandEditorStore>((set) => ({
  open: false,
  text: '',
  target: 'current',
  autoEnter: true,
  expandVars: true,
  setOpen: (open) => set({ open }),
  setText: (text) => set({ text }),
  setTarget: (target) => set({ target }),
  setAutoEnter: (autoEnter) => set({ autoEnter }),
  setExpandVars: (expandVars) => set({ expandVars })
}))
