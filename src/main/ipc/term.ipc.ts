import { z } from 'zod'
import { handle, onSend } from './registry'
import { sshManager } from '../ssh/SshConnectionManager'

const sizeSchema = z.object({
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500)
})

export function registerTermIpc(): void {
  handle(
    'term:open',
    ({ sessionId, cols, rows }) => sshManager.openShell(sessionId, cols, rows),
    z.tuple([sizeSchema.extend({ sessionId: z.string() })])
  )

  handle(
    'term:resize',
    ({ termId, cols, rows }) => {
      sshManager.getTerm(termId)?.resize(cols, rows)
    },
    z.tuple([sizeSchema.extend({ termId: z.string() })])
  )

  handle('term:close', (termId) => sshManager.closeTerm(termId), z.tuple([z.string()]))

  handle(
    'term:exec',
    ({ termId, command }) => {
      sshManager.getTerm(termId)?.write(command)
    },
    z.tuple([z.object({ termId: z.string(), command: z.string().max(65536) })])
  )

  // 高频热路径：不走 zod
  onSend('term:input', ({ termId, data }) => {
    sshManager.getTerm(termId)?.write(data)
  })
  onSend('term:flow-ack', ({ termId, bytes }) => {
    sshManager.getTerm(termId)?.ack(bytes)
  })
}
