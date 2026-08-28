import { z } from 'zod'
import { handle } from './registry'
import { portTrafficManager } from '../monitor/PortTrafficManager'

export function registerPortTrafficIpc(): void {
  handle('portTraffic:start', (sessionId) => portTrafficManager.start(sessionId), z.tuple([z.string()]))
  handle('portTraffic:stop', (sessionId) => portTrafficManager.stop(sessionId), z.tuple([z.string()]))
}
