import { z } from 'zod'
import { handle } from './registry'
import {
  confirmCloseEditorWindow,
  flushEditorQueue,
  openInEditorWindow
} from '../editorWindow'

/**
 * 独立编辑器窗口的三条通道（窗口生命周期本体在 editorWindow.ts）。
 *
 * openFile 的 zod 把三个字段都卡上限：sessionId 是 uuid、path 走远端路径的常规上限、
 * origin 只是标签上的显示名 —— 它们都会被塞进另一个窗口的界面里，不设限就等于
 * 主窗口的一个 bug 能往编辑器窗口里灌任意大的字符串。
 */
export function registerEditorIpc(): void {
  handle(
    'editor:openFile',
    (req) => {
      openInEditorWindow(req)
    },
    z.tuple([
      z.object({
        sessionId: z.string().min(1).max(64),
        path: z.string().min(1).max(4096),
        origin: z.string().max(200)
      })
    ])
  )

  handle('editor:ready', () => flushEditorQueue())

  handle('editor:closeNow', () => {
    confirmCloseEditorWindow()
  })
}
