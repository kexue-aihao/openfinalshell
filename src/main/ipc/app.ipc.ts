import { app, dialog, shell } from 'electron'
import { z } from 'zod'
import { handle } from './registry'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('app')

/** 终端/renderer 提供的 URL 属不可信内容，只放行 http/https */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export function registerAppIpc(): void {
  handle('app:getVersions', () => ({
    app: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? ''
  }))

  handle(
    'app:pickPath',
    async ({ mode, defaultPath, title }) => {
      if (mode === 'saveFile') {
        const r = await dialog.showSaveDialog({ defaultPath, title })
        return r.canceled || !r.filePath ? null : r.filePath
      }
      const r = await dialog.showOpenDialog({
        defaultPath,
        title,
        properties: [mode === 'openDirectory' ? 'openDirectory' : 'openFile']
      })
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
    },
    z.tuple([
      z.object({
        mode: z.enum(['openFile', 'saveFile', 'openDirectory']),
        defaultPath: z.string().optional(),
        title: z.string().optional()
      })
    ])
  )

  handle(
    'app:openExternal',
    async (url) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error('无效的链接')
      }
      if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        log.warn(`blocked openExternal for protocol ${parsed.protocol}`)
        throw new Error(`已阻止打开 ${parsed.protocol} 链接（仅允许 http/https）`)
      }
      await shell.openExternal(parsed.toString())
    },
    z.tuple([z.string().max(2048)])
  )

  handle(
    'app:openPath',
    (path) => {
      shell.showItemInFolder(path)
    },
    z.tuple([z.string()])
  )
}
