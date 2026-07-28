import { z } from 'zod'
import { handle } from './registry'
import { checkForUpdate, downloadUpdate, installUpdate } from '../services/updater'

/**
 * 自动更新的 IPC。三条都很薄，语义全在 services/updater.ts 里。
 *
 * `install` 收一个**必填** boolean 而不是可选的 —— 可选字段配 `?? false` 是最容易被
 * 顺手写成 `?? true` 的地方，而这里的默认值方向恰好是"不问就装"，
 * 那一下会断掉用户所有的终端会话（与 RemoteSaveGates 那三个必填开关同一条理由）。
 */
export function registerUpdateIpc(): void {
  handle('update:check', () => checkForUpdate(false))
  handle('update:download', () => downloadUpdate())
  handle('update:install', ({ force }) => installUpdate(force), z.tuple([z.object({ force: z.boolean() })]))
}
