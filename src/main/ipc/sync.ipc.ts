import { z } from 'zod'
import { handle } from './registry'
import { finishImportSideEffects } from './app.ipc'
import { lanSyncManager } from '../lansync/LanSyncManager'

/**
 * 局域网同步的 IPC。语义全在 lansync/LanSyncManager 里，这里只做契约 + zod 转调。
 *
 * sync:apply 的收尾（设置变更后重算窗口色 + 广播）与 app:importData 共用
 * finishImportSideEffects —— 两条导入路的界面收尾不该有第二种写法。
 */

const includeSchema = z.object({
  profiles: z.boolean(),
  snippets: z.boolean(),
  forwards: z.boolean(),
  knownHosts: z.boolean(),
  settings: z.boolean()
})

export function registerSyncIpc(): void {
  handle('sync:receiveStart', () => lanSyncManager.startReceive())
  handle('sync:receiveStop', () => lanSyncManager.stopReceive())
  handle('sync:receiveStatus', () => lanSyncManager.receiveStatus())
  handle('sync:scan', () => lanSyncManager.scan())

  handle(
    'sync:send',
    (opts) => lanSyncManager.send(opts),
    z.tuple([
      z.object({
        target: z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535) }),
        // 6 位数字配对码
        code: z.string().regex(/^\d{6}$/),
        includeSecrets: z.boolean()
      })
    ])
  )

  handle('sync:sendCancel', () => lanSyncManager.cancelSend())

  handle(
    'sync:apply',
    async (opts) => {
      const result = await lanSyncManager.applyIncoming(opts)
      finishImportSideEffects(result)
      return result
    },
    z.tuple([
      z.object({
        token: z.string().min(1).max(200),
        passphrase: z.string().max(256).optional(),
        conflict: z.enum(['skip', 'overwrite', 'duplicate']),
        include: includeSchema
      })
    ])
  )

  handle(
    'sync:dismiss',
    ({ token }) => lanSyncManager.dismissIncoming(token),
    z.tuple([z.object({ token: z.string().min(1).max(200) })])
  )
}
