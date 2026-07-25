import { z } from 'zod'
import { MONITOR_MAX_INTERVAL_MS, MONITOR_MIN_INTERVAL_MS } from '@shared/constants'
import { handle } from './registry'
import { monitorManager } from '../monitor/MonitorManager'

const intervalSchema = z.number().int().min(MONITOR_MIN_INTERVAL_MS).max(MONITOR_MAX_INTERVAL_MS)

export function registerMonitorIpc(): void {
  handle(
    'monitor:start',
    ({ sessionId, intervalMs }) => monitorManager.start(sessionId, intervalMs),
    z.tuple([z.object({ sessionId: z.string(), intervalMs: intervalSchema.optional() })])
  )

  handle('monitor:stop', (sessionId) => monitorManager.stop(sessionId), z.tuple([z.string()]))

  handle(
    'monitor:setInterval',
    ({ sessionId, intervalMs }) => monitorManager.setInterval(sessionId, intervalMs),
    z.tuple([z.object({ sessionId: z.string(), intervalMs: intervalSchema })])
  )
}
