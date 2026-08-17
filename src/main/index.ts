import { rm } from 'node:fs/promises'
import { app, BrowserWindow, Menu } from 'electron'
import { initLogger, logger } from './utils/logger'
import { getSettings, settingsStore } from './services/settings'
import { bindMainWindow } from './ipc/registry'
import { registerAppIpc } from './ipc/app.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'
import { registerConnIpc } from './ipc/conn.ipc'
import { registerSessionIpc } from './ipc/session.ipc'
import { registerTermIpc } from './ipc/term.ipc'
import { registerSnippetIpc } from './ipc/snippet.ipc'
import { registerSftpIpc } from './ipc/sftp.ipc'
import { registerMonitorIpc } from './ipc/monitor.ipc'
import { registerForwardIpc } from './ipc/forward.ipc'
import { registerHistoryIpc } from './ipc/history.ipc'
import { registerEditorIpc } from './ipc/editor.ipc'
import { closeEditorWindowIfOpen } from './editorWindow'
import { registerSavedRefsIpc } from './ipc/savedRefs.ipc'
import { registerUpdateIpc } from './ipc/update.ipc'
import { registerSyncIpc } from './ipc/sync.ipc'
import { monitorManager } from './monitor/MonitorManager'
import { forwardManager } from './forward/ForwardManager'
import { lanSyncManager } from './lansync/LanSyncManager'
import { flushForwards } from './store/forwards'
import { packTempDir, transferQueue } from './sftp/TransferQueue'
import { sshManager } from './ssh/SshConnectionManager'
import { closeDatabase } from './store/Database'
import { encryptExistingRowsOnce } from './store/encryptMigration'
import { flushConnections, migrateInlineRefsOnce } from './store/connections'
import { flushSavedRefs } from './store/savedRefs'
import { flushSnippets } from './store/snippets'
import { flushKnownHosts } from './ssh/hostkeys'
import { vault } from './store/Vault'
import { createMainWindow } from './window'
import { startUpdateChecks, stopUpdateChecks } from './services/updater'

initLogger()

// ---- 崩溃兜底：main 进程任何未捕获异常只记日志，不崩进程 ----
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', reason)
})

// ---- 单实例锁 ----
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  if (getSettings().disableGpu) {
    app.disableHardwareAcceleration()
  }

  /**
   * 明确取消应用菜单。
   *
   * 从来没调过 setApplicationMenu，于是 Electron 自动装了一份默认菜单 —— 窗口用
   * titleBarStyle:'hidden' 所以那份菜单**看不见**，但它的加速键是真的在生效：
   * `Ctrl+R` / `Ctrl+Shift+R` 重载整个渲染进程（所有终端连接与传输队列当场没了）、
   * `Ctrl+Shift+I` 弹出开发者工具、`Ctrl+Shift+C` 进元素选取模式。
   * 一个看不见的菜单能一键把用户的会话全清掉，这是纯粹的失误面。
   *
   * 排在建窗之前：默认菜单是在窗口创建时挂上去的。
   */
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null)

    /**
     * 内联代理/私钥 → 可复用实体的一次性迁移。
     *
     * 显式排在注册 IPC 之前，而不是挂在 listConnections() 这种读路径上：
     * 迁移会改写 profiles 表，让它发生在一个确定的时刻比"第一次有人列连接时"好排查；
     * 而且拨号侧（auth.ts）读 profile 时不该还有没迁移完的可能。
     * 函数内部由 meta 标记挡住，重复调用无副作用。
     */
    migrateInlineRefsOnce()

    /**
     * 配置数据静态加密（at-rest）的一次性迁移：把库里现有明文行就地加密。
     * 排在 migrateInlineRefsOnce 之后——那步可能新建代理/私钥行，这步再统一把全库扫成密文。
     * 内部由 meta 标记挡住，且 safeStorage 不可用时直接跳过、不写标记（等可用了再跑）。
     */
    encryptExistingRowsOnce()

    registerAppIpc()
    registerSettingsIpc()
    registerConnIpc()
    registerSessionIpc()
    registerTermIpc()
    registerSnippetIpc()
    registerSftpIpc()
    registerMonitorIpc()
    registerForwardIpc()
    registerHistoryIpc()
    registerSavedRefsIpc()
    registerUpdateIpc()
    registerEditorIpc()
    registerSyncIpc()

    /**
     * 清掉上次崩溃/被杀时留下的编辑临时根：里面是远端文件的**明文副本**，
     * 不该在 %TEMP% 下长住。放在这儿的两个理由：
     *  - 必须在 app ready 之后 —— 它要 app.getPath('temp')，模块顶层那会儿还没准备好；
     *  - 必须在 requestSingleInstanceLock 之后（我们就在那个 else 分支里）——
     *    否则第二个实例启动时会把第一个实例正在用的目录删掉。
     * best-effort：函数内部逐个 catch，不会抛，失败也不该拦住启动。
     */

    /**
     * 同理清掉打包下载的本地临时目录。它整个目录都是可丢的（里面只有 `<taskId>.tar`），
     * 所以直接删整棵 —— 与上面那条一样，必须排在单实例锁之后，否则会删掉另一个实例正在传的包。
     * 没有这条，一次 4GB 打包下载崩在中途就静默漏 4GB 的 %TEMP%。
     */
    void rm(packTempDir(), { recursive: true, force: true }).catch(() => {})

    const win = createMainWindow()
    bindMainWindow(win)
    // 主窗口关了就把编辑器窗口也带走（走同一条脏文件裁决链路，不硬杀）；
    // 全部窗口收尾后 window-all-closed 才让应用退出
    win.on('closed', () => closeEditorWindowIfOpen())

    // 更新检查排在建窗之后：它要往窗口推状态事件，而且延迟 10 秒才真的查
    startUpdateChecks()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        bindMainWindow(createMainWindow())
      }
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    stopUpdateChecks()
    transferQueue.cancelAll()
    monitorManager.stopAll()
    forwardManager.stopAll()
    // 局域网同步：关监听 + 停发现应答 + 销毁连接。必须先于 closeDatabase()
    lanSyncManager.stopAll()
    /**
     * 停掉每条编辑并删掉本进程那个临时根 —— 不清就是把远端文件的明文副本留在 %TEMP% 里。
     * 它是 async 而 before-quit 是同步钩子：和下面几个 flush 一样按 best-effort 处理
     * （拖延退出去等一次目录删除不值得，真没删掉的下次启动时 purgeStaleTempDirs 会收走）。
     */
    sshManager.closeAll()
    void settingsStore().flush()
    void flushConnections()
    void flushSavedRefs()
    void flushKnownHosts()
    void flushSnippets()
    void flushForwards()
    void vault.flush()
    // 关掉数据库连接：WAL 会在最后一个连接关闭时归并回主库，
    // 不关会留下 -wal/-shm 文件（能自愈，但卸载清理与备份都更干净些）
    closeDatabase()
  })
}
