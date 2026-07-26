import { constants, promises as fs } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
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
  if (metaGet('sftp_show_hidden_default_v2')) return
  patchSettings({ sftp: { ...getSettings().sftp, showHiddenFiles: true } })
  metaSet('sftp_show_hidden_default_v2', String(Date.now()))
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
 * 分层一个字没变，只是"外来数据"从一处变成了两处：**IPC 边界（settings:set）与
 * 导入文件（applyImport）都不信任，主进程内部调用可信**。所以剥离必须待在这两个入口上，
 * **不能**下沉进 patchSettings —— sftp:pickEditor 校验完那个 exe 之后照样要靠
 * patchSettings 把它写进去，塞进 patchSettings 会把唯一的正路一起堵死。
 *
 * 为什么落在 services/settings.ts 而不是各入口自己写一份：上一版只有 settings:set 剥，
 * 导入配置那条路（换机迁移 / 同事分享一份导出文件）整条绕过去 —— 文件里写一个
 * sftp.externalEditorPath 就能让受害者此后每次"编辑远端文件"都执行指定的 exe。
 * 一份实现两个入口共用，以后再多一个写设置的入口，抄的也是同一份。
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
  current: AppSettings
): { patch: Partial<AppSettings>; stripped: string[] } {
  let next = patch
  const stripped: string[] = []
  for (const path of MAIN_ONLY_SETTINGS_PATHS) {
    const [section, key] = path.split('.')
    const incoming = (next as Record<string, unknown>)[section]
    if (!isRecord(incoming) || !(key in incoming)) continue
    const stored = (current as unknown as Record<string, unknown>)[section]
    if (!isRecord(stored) || incoming[key] !== stored[key]) {
      log.warn(`ignored externally supplied ${path} (main-only: 只能由 sftp:pickEditor 写入)`)
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

/**
 * 校验一个"编辑远端文件用的编辑器"能不能用。
 *
 * 两处都要调：**写入时**（sftp:pickEditor 拿到对话框结果）和**用之前**（spawn 之前）。
 * 只在写入时校验挡不住已经躺在库里的坏值 —— 那个值可能是导入的配置文件带来的、
 * 可能是老版本写下的、也可能是有人直接改了 SQLite。不管它怎么进来的，用之前都要再看一眼。
 * 也正因为如此不做缓存：exe 可以在两次存盘之间被换掉。
 *
 * 放在 services/settings.ts：它校验的就是 settings.sftp.externalEditorPath 这一个字段，
 * 而 RemoteEditManager 早已在 openEditor 里动态 import 本模块取设置（静态 import 会把
 * store/Database 拖进它的单测），顺手多拿一个函数不新增任何依赖方向 ——
 * 从 sftp.ipc.ts 拿就成环了（那边反过来 import RemoteEditManager）。
 *
 * 逐条为什么：
 *  1. **必须绝对路径**。裸名字（`notepad`）不只是"不规范"：libuv 的 search_path 在文件名
 *     不含目录分隔符时会**先试当前工作目录**再走 PATH，portable 版从下载目录里运行时，
 *     那里被投放的同名 exe 就赢了。
 *  2. **win32 上拒 UNC / 设备路径**（`\\host\share\editor.exe`、`\\?\…`）。isAbsolute 认它们，
 *     扩展名照样是 .exe，fs.stat 经 SMB 也报 isFile —— 于是每次存盘都从远端共享起进程，
 *     而共享上的内容随时可换（换的人还不一定是你）。对话框只会给盘符路径，拒掉不误伤。
 *  3. **win32 上只允许 .exe**。`.bat`/`.cmd` 不是"另一种可执行文件"：Windows 只能经
 *     cmd.exe 解释它们（Node 起 .bat 必须 shell: true），等于把 launchEditor 里
 *     `shell: false` 挡掉的那层 shell 又请回来 —— 而我们传给它的参数是一条远端文件名
 *     派生出来的本地路径。放行 .bat 就是把命令注入的缝重新开出来。
 *  4. **必须存在且是普通文件**。选到目录/断链只会让 spawn 在用户按下 Ctrl+S 的那一刻才失败，
 *     在设置里当场说清楚比那时候好。
 *  5. **非 win32 查可执行位**（X_OK）。那边没有扩展名可看，而本项目发 AppImage/deb ——
 *     不查的话一个纯文本文件也能存进设置，直到存盘那刻才 EACCES。
 *     必须排在 isFile 之后：目录对 X_OK 是通过的（那是"可进入"），先查它等于放行目录。
 */
export async function assertUsableEditor(exePath: string): Promise<void> {
  if (!isAbsolute(exePath)) throw new Error(`编辑器必须是绝对路径：${exePath}`)
  if (process.platform === 'win32') {
    // 两个前导分隔符 = UNC（\\host\share）或 \\?\ / \\.\ 设备路径
    if (/^[\\/]{2}/.test(exePath)) {
      throw new Error(`编辑器只能是本机盘符上的路径，不接受 UNC/网络共享：${exePath}`)
    }
    if (extname(exePath).toLowerCase() !== '.exe') {
      throw new Error('Windows 上只接受 .exe（.bat/.cmd 要经 cmd.exe 解释执行，不安全）')
    }
  }
  const stat = await fs.stat(exePath).catch(() => null)
  if (!stat) throw new Error(`选中的文件不存在或不可读：${exePath}`)
  if (!stat.isFile()) throw new Error(`不是文件，不能作为编辑器：${exePath}`)
  if (process.platform !== 'win32') {
    // 用异步 access 而不是 accessSync：这函数整条已经是 async，没必要让主进程做同步 IO
    const executable = await fs.access(exePath, constants.X_OK).then(
      () => true,
      () => false
    )
    if (!executable) throw new Error(`没有可执行权限，不能作为编辑器：${exePath}`)
  }
}
