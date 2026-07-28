import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type {
  UpdateActivity,
  UpdateInstallResult,
  UpdateState
} from '@shared/types'
import { emit } from '../ipc/registry'
import { getSettings } from './settings'
import { decideInstall } from './updateGate'
import { transferQueue } from '../sftp/TransferQueue'
import { monitorManager } from '../monitor/MonitorManager'
import { forwardManager } from '../forward/ForwardManager'
import { sshManager } from '../ssh/SshConnectionManager'
import { closeDatabase } from '../store/Database'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('updater')

/**
 * 应用内自动更新（electron-updater + NSIS 差量包）。
 *
 * ---
 *
 * **三条约束决定了这个文件的形状：**
 *
 * 1. **绝不自己重启。** 这是个 SSH 客户端：窗口里跑着活的终端会话、传输队列与端口转发。
 *    `autoInstallOnAppQuit = false` + 只在用户显式点「重启并安装」时才装，
 *    而且装之前先告诉他这一下会断掉几条会话、几个传输（`UpdateActivity`）。
 * 2. **免安装版一律不装。** nsis 与 portable 共享同一个 `win-unpacked`，所以免安装版的
 *    resources 里**也有** `app-update.yml`。不拦住的话，免安装用户会被下载一个安装包
 *    并装到 `%LOCALAPPDATA%` —— 等于被悄悄变成安装版。判据是 portable 启动器注入的
 *    `PORTABLE_EXECUTABLE_DIR`（见 app-builder-lib 的 templates/nsis/portable.nsi）。
 * 3. **dev 里整个短路。** 未打包时 autoUpdater 会去找项目根的 `dev-app-update.yml`
 *    然后抛错，那个报错对开发毫无意义。
 *
 * 安装前的收摊顺序是刻意的：`before-quit` 里那几个 flush 是 `void` 掉的 async，
 * 而 NSIS 在 `--updated` 路径下**不弹"应用正在运行"对话框、直接 kill**
 * （allowOnlyOneInstallerInstance.nsh）。所以不能指望退出钩子跑完 ——
 * 自己按顺序停掉、并**同步**关库（closeDatabase 本来就是同步的），再交给安装器。
 */

// electron-updater 是 CJS，默认导出上挂着 autoUpdater
const { autoUpdater } = electronUpdater

/** 免安装版：portable 启动器会注入这个环境变量 */
function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

let state: UpdateState = { status: 'idle', current: app.getVersion() }
let timer: NodeJS.Timeout | null = null
let wired = false

function publish(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  emit('update:state', state)
}

export function updateState(): UpdateState {
  return state
}

/** 这一下装更新会断掉什么 */
export function updateActivity(): UpdateActivity {
  const tasks = transferQueue.list()
  return {
    sessions: sshManager.liveCount(),
    transfers: tasks.filter((t) => t.state === 'running' || t.state === 'queued').length,
    forwards: forwardManager.listRuntimes().filter((r) => r.state === 'active').length
  }
}

function wire(): void {
  if (wired) return
  wired = true

  // 日志接到 electron-log：差量到底走没走、省了多少，只有这里看得见
  autoUpdater.logger = {
    info: (m: unknown) => log.info(String(m)),
    warn: (m: unknown) => log.warn(String(m)),
    error: (m: unknown) => log.error(String(m)),
    debug: (m: unknown) => log.debug(String(m))
  }
  autoUpdater.autoDownload = true
  // ⚠️ 绝不在退出时偷偷装 —— 见文件头第 1 条
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => publish({ status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) =>
    publish({ status: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', () => publish({ status: 'none' }))
  autoUpdater.on('download-progress', (p) =>
    publish({
      status: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total
    })
  )
  autoUpdater.on('update-downloaded', (info) =>
    publish({ status: 'downloaded', version: info.version, percent: 100 })
  )
  autoUpdater.on('error', (err) => {
    // 网络不通、feed 404、校验失败都会走这里；不重试也不弹窗，界面上留一行
    log.warn(`update error: ${err.message}`)
    publish({ status: 'error', error: err.message })
  })
}

/**
 * 检查一次。`silent` 时（自动检查）出错只落日志不改状态 ——
 * 断网的人不该每次启动都看见一条红字。
 */
export async function checkForUpdate(silent = false): Promise<UpdateState> {
  if (!app.isPackaged) return state
  if (isPortable()) {
    publish({ status: 'unsupported' })
    return state
  }
  wire()
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`check failed: ${message}`)
    if (!silent) publish({ status: 'error', error: message })
  }
  return state
}

/** 手动触发下载（autoDownload 已开，这条是给"检查到但没自动下"兜底用的） */
export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged || isPortable()) return
  wire()
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    publish({ status: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * 装。`force=false` 时若有活动会话/传输/转发，**先回一份清单让界面去确认**，
 * 一个字节都不装 —— 与内置编辑器保存那三道闸门是同一套思路：
 * main 侧持有事实，界面负责问，用户确认后带着 force 再来一次。
 */
export function installUpdate(force: boolean): UpdateInstallResult {
  const activity = updateActivity()
  // 判断本身在 updateGate.ts（不 import electron-updater，所以有真正的行为用例）
  const decision = decideInstall({
    packaged: app.isPackaged,
    portable: isPortable(),
    downloaded: state.status === 'downloaded',
    force,
    activity
  })
  if (decision.kind === 'reject') {
    return {
      error: {
        notPackaged: '开发模式下不能安装更新',
        portable: '免安装版请到 Releases 下载新版覆盖',
        notDownloaded: '更新还没下载完'
      }[decision.reason]
    }
  }
  if (decision.kind === 'confirm') return { needsConfirm: decision.activity }

  log.info(`installing update ${state.version ?? ''}: ${JSON.stringify(activity)}`)
  /*
   * 按顺序收摊。不能指望 before-quit —— 它是同步钩子而里面那几个 flush 是
   * void 掉的 async，而安装器在 --updated 路径下会直接 kill 掉本进程。
   */
  transferQueue.cancelAll()
  monitorManager.stopAll()
  forwardManager.stopAll()
  sshManager.closeAll()
  closeDatabase()

  // isSilent=false：assisted installer（oneClick:false）下让安装器自己走它那套页面；
  // isForceRunAfter=true：装完自动把应用拉起来，用户不用自己再点一次图标
  autoUpdater.quitAndInstall(false, true)
  return { installing: true }
}

/**
 * 启动时接上：延迟 10 秒查一次，之后每 6 小时一次。
 *
 * 延迟是为了不和建窗、首条 SSH 连接抢那几百毫秒 —— 更新检查一次网络往返，
 * 而用户开着软件的第一件事通常是连服务器。
 */
export function startUpdateChecks(): void {
  if (!app.isPackaged) return
  if (isPortable()) {
    publish({ status: 'unsupported' })
    return
  }
  const tick = (): void => {
    if (!getSettings().autoCheckUpdate) return
    void checkForUpdate(true)
  }
  setTimeout(tick, 10_000)
  timer = setInterval(tick, 6 * 60 * 60 * 1000)
}

export function stopUpdateChecks(): void {
  if (timer) clearInterval(timer)
  timer = null
}
