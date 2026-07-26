import { rm } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
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
import { monitorManager } from './monitor/MonitorManager'
import { forwardManager } from './forward/ForwardManager'
import { flushForwards } from './store/forwards'
import { packTempDir, transferQueue } from './sftp/TransferQueue'
import { remoteEditManager } from './sftp/RemoteEditManager'
import { sshManager } from './ssh/SshConnectionManager'
import { closeDatabase } from './store/Database'
import { flushConnections } from './store/connections'
import { flushSnippets } from './store/snippets'
import { flushKnownHosts } from './ssh/hostkeys'
import { vault } from './store/Vault'
import { createMainWindow } from './window'

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

  void app.whenReady().then(() => {
    registerAppIpc()
    registerSettingsIpc()
    registerConnIpc()
    registerSessionIpc()
    registerTermIpc()
    registerSnippetIpc()
    registerSftpIpc()
    registerMonitorIpc()
    registerForwardIpc()

    /**
     * 清掉上次崩溃/被杀时留下的编辑临时根：里面是远端文件的**明文副本**，
     * 不该在 %TEMP% 下长住。放在这儿的两个理由：
     *  - 必须在 app ready 之后 —— 它要 app.getPath('temp')，模块顶层那会儿还没准备好；
     *  - 必须在 requestSingleInstanceLock 之后（我们就在那个 else 分支里）——
     *    否则第二个实例启动时会把第一个实例正在用的目录删掉。
     * best-effort：函数内部逐个 catch，不会抛，失败也不该拦住启动。
     */
    void remoteEditManager.purgeStaleTempDirs()

    /**
     * 同理清掉打包下载的本地临时目录。它整个目录都是可丢的（里面只有 `<taskId>.tar`），
     * 所以直接删整棵 —— 与上面那条一样，必须排在单实例锁之后，否则会删掉另一个实例正在传的包。
     * 没有这条，一次 4GB 打包下载崩在中途就静默漏 4GB 的 %TEMP%。
     */
    void rm(packTempDir(), { recursive: true, force: true }).catch(() => {})

    const win = createMainWindow()
    bindMainWindow(win)

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
    transferQueue.cancelAll()
    monitorManager.stopAll()
    forwardManager.stopAll()
    /**
     * 停掉每条编辑并删掉本进程那个临时根 —— 不清就是把远端文件的明文副本留在 %TEMP% 里。
     * 它是 async 而 before-quit 是同步钩子：和下面几个 flush 一样按 best-effort 处理
     * （拖延退出去等一次目录删除不值得，真没删掉的下次启动时 purgeStaleTempDirs 会收走）。
     */
    void remoteEditManager.stopAll()
    sshManager.closeAll()
    void settingsStore().flush()
    void flushConnections()
    void flushKnownHosts()
    void flushSnippets()
    void flushForwards()
    void vault.flush()
    // 关掉数据库连接：WAL 会在最后一个连接关闭时归并回主库，
    // 不关会留下 -wal/-shm 文件（能自愈，但卸载清理与备份都更干净些）
    closeDatabase()
  })
}
