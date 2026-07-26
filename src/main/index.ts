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
import { transferQueue } from './sftp/TransferQueue'
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
