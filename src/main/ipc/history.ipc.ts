import { z } from 'zod'
import { COMMAND_HISTORY_MAX_CHARS } from '@shared/constants'
import { handle } from './registry'
import { clearCommandHistory, listCommandHistory, pushCommandHistory } from '../store/commandHistory'

/**
 * 命令历史的 IPC。三条都很小，唯一值得说的是 push 那条为什么带 schema：
 * 它的入参是用户敲进服务器的原话，长度不设上限就等于让渲染进程的一个 bug
 * 能往库里写任意大的字符串。理由完整写在 shared/ipc.ts 那条 channel 的注释里。
 */
export function registerHistoryIpc(): void {
  handle('history:list', () => listCommandHistory())

  handle(
    'history:push',
    ({ command }) => {
      pushCommandHistory(command)
    },
    z.tuple([z.object({ command: z.string().min(1).max(COMMAND_HISTORY_MAX_CHARS) })])
  )

  handle('history:clear', () => clearCommandHistory())
}
