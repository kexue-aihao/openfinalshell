import { z } from 'zod'
import { handle } from './registry'
import { deleteForward, getForward, listForwards, saveForward } from '../store/forwards'
import { forwardManager } from '../forward/ForwardManager'

const ruleSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  type: z.enum(['local', 'remote', 'dynamic']),
  label: z.string().max(120),
  bindAddr: z.string().max(255),
  bindPort: z.number().int().min(1).max(65535),
  dstHost: z.string().max(255).optional(),
  dstPort: z.number().int().min(1).max(65535).optional(),
  autoStart: z.boolean()
})

export function registerForwardIpc(): void {
  handle(
    'forward:list',
    (profileId) =>
      listForwards(profileId).map((rule) => ({
        ...rule,
        runtime: forwardManager.runtimeOf(rule.id)
      })),
    z.tuple([z.string().nullable()])
  )

  handle('forward:save', (rule) => void saveForward(rule), z.tuple([ruleSchema]))

  handle(
    'forward:delete',
    (id) => {
      forwardManager.stop(id)
      deleteForward(id)
    },
    z.tuple([z.string()])
  )

  handle(
    'forward:control',
    async ({ forwardId, sessionId, op }) => {
      if (op === 'stop') {
        forwardManager.stop(forwardId)
        return
      }
      const rule = getForward(forwardId)
      if (!rule) throw new Error('转发规则不存在')
      await forwardManager.start(rule, sessionId)
    },
    z.tuple([
      z.object({ forwardId: z.string(), sessionId: z.string(), op: z.enum(['start', 'stop']) })
    ])
  )
}
