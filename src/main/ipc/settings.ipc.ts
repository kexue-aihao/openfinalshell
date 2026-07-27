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
   * ⚠️ 那张表**目前是空的**（唯一那条随外部编辑器删掉了），所以这一步此刻是恒等的。
   * 留着它是因为**两个外来入口都得接着同一份实现**：上一版只有这条 channel 剥，
   * 导入配置那条整条绕过去。理由与那张表的注释见 shared/ipc.ts 与 services/settings.ts。
   *
   * 剥离刻意没有下沉进 patchSettings：main 自己写这些字段时走的也是它，
   * 塞进去会把唯一的正路一起堵死。
   *
   * 这里丢掉 stripped：谁被剥掉了由 stripMainOnlyPaths 自己 warn 到日志（值真变了才记）。
   * 界面不需要知道 —— 设置页每次保存都会原样带上那些键，回报给它只会变成一个假警报。
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
