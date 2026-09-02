import { DEFAULT_SETTINGS } from '@shared/constants'
import { MAIN_ONLY_SETTINGS_PATHS } from '@shared/ipc'
import type { AppSettings } from '@shared/types'
import { deepMerge } from '../store/ConfigStore'
import { DocStore } from '../store/DocStore'
import { metaGet, metaSet } from '../store/Database'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('settings')

let store: DocStore<AppSettings> | null = null

/**
 * 一次性迁移：把 showHiddenFiles 掀成 true。
 *
 * 光改 DEFAULT_SETTINGS 对老用户没用 —— patchSettings 每次都把整份合并结果写回，
 * 所以他们库里已经**显式**存着 false，而 DocStore.data 是 deepMerge(defaults, stored)、
 * stored 赢。要生效就只能真的改一次存量数据。
 *
 * 代价说清楚：这会覆盖"当初自己主动关掉隐藏文件"的选择。取舍是隐藏文件对 Linux
 * 服务器运维几乎总是要看的（.ssh/.env/.bashrc），而工具栏那个眼睛按钮随手就能关回去。
 * 标记与改动同一次写入，所以之后用户关掉了就再也不会被掀开。
 */
function migrateOnce(): void {
  // `reduceTransparency` 是纯展示偏好：老配置没有它时 DocStore 的深合并已经给出默认 false，
  // 不应为了写入一个默认值打扰用户。只有历史数据被手工改成非布尔值时才修复，避免它一路
  // 进入 renderer 后把 CSS 的 data 属性变成不可预期的状态。
  if (typeof getSettings().reduceTransparency !== 'boolean') {
    patchSettings({ reduceTransparency: DEFAULT_SETTINGS.reduceTransparency })
  }
  if (!metaGet('sftp_show_hidden_default_v2')) {
    patchSettings({ sftp: { ...getSettings().sftp, showHiddenFiles: true } })
    metaSet('sftp_show_hidden_default_v2', String(Date.now()))
  }
  // 默认最大化打开：老用户库里显式存着 maximized:false（persistBounds 每次关窗都写），
  // 光改 DEFAULT_SETTINGS 掀不动，和 showHiddenFiles 同样的坑，同样一次性迁移。
  // 之后用户拖成浮窗关掉，persistBounds 会记住 false，再不会被掀成最大化。
  if (!metaGet('window_maximized_default_v1')) {
    patchSettings({ window: { ...getSettings().window, maximized: true } })
    metaSet('window_maximized_default_v1', String(Date.now()))
  }
}

export function settingsStore(): DocStore<AppSettings> {
  if (!store) {
    store = new DocStore<AppSettings>('settings', () => structuredClone(DEFAULT_SETTINGS))
    migrateOnce()
  }
  return store
}

export function getSettings(): AppSettings {
  return settingsStore().data
}

export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = deepMerge(settingsStore().data, patch)
  settingsStore().set(merged)
  return merged
}

// ---------------------------------------------------------------------------
// 只许 main 自己写的字段
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 把 MAIN_ONLY_SETTINGS_PATHS 里的键从**外来** patch 里剥掉，并回报剥掉了哪几条。
 *
 * "外来数据"有**两个**入口：**IPC 边界（settings:set）与导入文件（applyImport）都不信任，
 * 主进程内部调用可信**。所以剥离必须待在这两个入口上，**不能**下沉进 patchSettings ——
 * main 自己写这些字段时走的也是 patchSettings，塞进去会把唯一的正路一起堵死。
 *
 * 为什么落在 services/settings.ts 而不是各入口自己写一份：上一版只有 settings:set 剥，
 * 导入配置那条路（换机迁移 / 同事分享一份导出文件）整条绕过去。一份实现两个入口共用，
 * 以后再多一个写设置的入口，抄的也是同一份。
 *
 * ⚠️ MAIN_ONLY_SETTINGS_PATHS **目前是空的**（那一条键随外部编辑器删掉了），
 * 所以这个函数此刻是个恒等函数。它没在假装防什么 —— 留着的是上面那条分层，
 * 理由见那张表的注释。
 *
 * 剥掉而不是报错：设置页保存时会把整份 settings 原样带上（含这一键），
 * 报错会让"改个终端字号"都保存失败；导入同理，不该因为一个键让整份配置都进不来。
 *
 * 只在值真的对不上时才 warn —— 每次保存都带着同一个旧值进来是正常流量，
 * 记一行只是噪音；值变了才说明有人（界面、导入文件或别的什么）想改一个它改不了的字段，
 * 那正是日后排查"我明明设置了怎么没生效"要看的那行。
 */
export function stripMainOnlyPaths(
  patch: Partial<AppSettings>,
  current: AppSettings,
  /**
   * 只给单测用的注入口。
   *
   * 表**目前是空的**，于是这个函数在生产里是恒等的 —— 而"三种 patch 形状都要剥干净"
   * 那几条用例本身仍然值得留着：它们守的是循环的行为，而那份行为要在**下一次**
   * 有人往表里加键的当天就是对的，不能等到那天再重新写一遍。
   * 注入一个假路径就能把那几条用例继续跑起来，而不必让生产代码假装在防什么。
   */
  paths: readonly string[] = MAIN_ONLY_SETTINGS_PATHS
): { patch: Partial<AppSettings>; stripped: string[] } {
  let next = patch
  const stripped: string[] = []
  for (const path of paths) {
    const [section, key] = path.split('.')
    const incoming = (next as Record<string, unknown>)[section]
    if (!isRecord(incoming) || !(key in incoming)) continue
    const stored = (current as unknown as Record<string, unknown>)[section]
    if (!isRecord(stored) || incoming[key] !== stored[key]) {
      log.warn(`ignored externally supplied ${path} (main-only: 只能由主进程自己写入)`)
    }
    const rest = { ...incoming }
    delete rest[key]
    // 计算键的展开对 TS 只是 Record，落回 Partial<AppSettings> 需要这一次断言；
    // 少一个键在运行时是安全的 —— patchSettings 是深合并，缺键就是"这一项不改"
    next = { ...next, [section]: rest } as Partial<AppSettings>
    stripped.push(path)
  }
  return { patch: next, stripped }
}
