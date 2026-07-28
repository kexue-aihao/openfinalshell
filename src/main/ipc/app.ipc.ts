import { app, dialog, shell } from 'electron'
import { z } from 'zod'
import { emit, handle } from './registry'
import { exportData } from '../services/exportData'
import { applyImport, inspectImport } from '../services/importData'
import { applyFinalShellImport, scanFinalShell } from '../services/finalshellImport'
import { getSettings } from '../services/settings'
import { applyWindowChrome } from '../window'
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

  /**
   * `properties` 里**永远只有一个选择器类型**。
   *
   * electron.d.ts 原话（showOpenDialog 的 properties）：Windows 与 Linux 上打开对话框
   * 不能同时是文件选择器和目录选择器，`['openFile','openDirectory']` 只会显示**目录**
   * 选择器。这正是最难发现的一类坏法：编译过、不抛错、"选文件"这个入口静默变成
   * "只能选文件夹"。所以界面上是两个入口，各传一个 mode，一条代码路径。
   */
  handle(
    'app:pickPaths',
    async ({ mode, defaultPath, title }) => {
      const r = await dialog.showOpenDialog({
        defaultPath,
        title,
        properties: [mode, 'multiSelections']
      })
      return r.canceled ? [] : r.filePaths
    },
    z.tuple([
      z.object({
        mode: z.enum(['openFile', 'openDirectory']),
        defaultPath: z.string().max(4096).optional(),
        title: z.string().max(200).optional()
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

  handle(
    'app:exportData',
    (opts) => exportData(opts),
    z.tuple([
      z.object({
        includeSecrets: z.boolean(),
        passphrase: z.string().max(256).optional()
      })
    ])
  )

  // 选文件与解析都在 main 侧完成，renderer 只拿回一个 token —— 它没有机会指定路径
  handle('app:importPreview', () => inspectImport())

  handle(
    'app:importData',
    async (opts) => {
      const result = await applyImport(opts)
      // 设置是唯一会立刻改变界面的部分，导入后要主动推给 renderer 并重算窗口色
      if (result.settingsApplied) {
        const next = getSettings()
        applyWindowChrome(next)
        emit('settings:changed', next)
      }
      return result
    },
    z.tuple([
      z.object({
        token: z.string().min(1).max(200),
        passphrase: z.string().max(256).optional(),
        conflict: z.enum(['skip', 'overwrite', 'duplicate']),
        include: z.object({
          profiles: z.boolean(),
          snippets: z.boolean(),
          forwards: z.boolean(),
          knownHosts: z.boolean(),
          settings: z.boolean()
        })
      })
    ])
  )

  /**
   * FinalShell 导入。与本项目自己的导入同一条形状：main 选目录 + 解析 → 只回 token。
   *
   * `dir` 在 schema 里是可选的，但**渲染进程正常路径下不传** —— 它存在只为测试与冒烟
   * （那两处没法点系统对话框）。传了也只是决定"读哪个目录"，读到的内容一律当外来数据校验，
   * 而写库那一步走的是 saveProfile（唯一的加密入口），不因为路径由谁给而变。
   */
  handle(
    'app:finalshellScan',
    (opts) => scanFinalShell(opts),
    z.tuple([z.object({ dir: z.string().max(4096).optional() })])
  )

  handle(
    'app:finalshellImport',
    (opts) => applyFinalShellImport(opts),
    z.tuple([
      z.object({
        token: z.string().min(1).max(200),
        conflict: z.enum(['skip', 'duplicate'])
      })
    ])
  )
}
