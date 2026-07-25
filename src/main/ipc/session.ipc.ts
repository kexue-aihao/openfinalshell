import { z } from 'zod'
import { handle } from './registry'
import { sshManager } from '../ssh/SshConnectionManager'
import { promptBroker } from '../ssh/PromptBroker'

export function registerSessionIpc(): void {
  handle('session:open', (profileId) => sshManager.open(profileId), z.tuple([z.string()]))

  handle('session:close', (sessionId) => sshManager.close(sessionId), z.tuple([z.string()]))

  // M2 完整实现（断线重连状态机）；当前语义 = 无操作占位
  handle('session:reconnect', () => undefined, z.tuple([z.string()]))

  handle(
    'session:promptReply',
    (reply) => promptBroker.reply(reply),
    z.tuple([
      z.object({
        requestId: z.string(),
        ok: z.boolean(),
        answers: z.array(z.string().max(4096)).optional(),
        remember: z.boolean().optional()
      })
    ])
  )
}
