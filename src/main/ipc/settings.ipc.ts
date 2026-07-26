import { z } from 'zod'
import { safeStorage } from 'electron'
import { emit, handle } from './registry'
import { getSettings, patchSettings, stripMainOnlyPaths } from '../services/settings'
import { applyWindowChrome } from '../window'

export function registerSettingsIpc(): void {
  handle('settings:get', () => getSettings())

  /**
   * 渲染进程给的 patch 先过一遍 stripMainOnlyPaths（实现与分层说明见 services/settings.ts）：
   * **IPC 边界不信任外来数据**，MAIN_ONLY_SETTINGS_PATHS 里的键一律剥掉 ——
   * 那张表里的 sftp.externalEditorPath 最终是 spawn 的可执行文件，渲染进程能写它
   * 就等于能执行本机任意程序。剥离刻意没有下沉进 patchSettings：sftp:pickEditor
   * 在 main 侧校验完 exe 之后，仍要靠 patchSettings 把它写进去。
   *
   * 这里丢掉 stripped：谁被剥掉了由 stripMainOnlyPaths 自己 warn 到日志（值真变了才记）。
   * 界面不需要知道 —— 设置页每次保存都会原样带上这一键，回报给它只会变成一个假警报。
   */
  handle(
    'settings:set',
    (patch) => {
      const guarded = stripMainOnlyPaths(patch, getSettings())
      const next = patchSettings(guarded.patch)
      applyWindowChrome(next)
      emit('settings:changed', next)
      return next
    },
    z.tuple([z.record(z.string(), z.unknown())])
  )

  handle('vault:isAvailable', () => safeStorage.isEncryptionAvailable())
}
