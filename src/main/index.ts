import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { app, BrowserWindow, Menu, dialog, type MenuItemConstructorOptions } from 'electron'
import { initLogger, logger } from './utils/logger'
import { getSettings, settingsStore } from './services/settings'
import { bindInstance, handle } from './ipc/registry'
import { currentInstance } from './instance'
import { registerAppIpc } from './ipc/app.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'
import { registerConnIpc } from './ipc/conn.ipc'
import { registerSessionIpc } from './ipc/session.ipc'
import { registerTermIpc } from './ipc/term.ipc'
import { registerSnippetIpc } from './ipc/snippet.ipc'
import { registerSftpIpc } from './ipc/sftp.ipc'
import { registerMonitorIpc } from './ipc/monitor.ipc'
import { registerPortTrafficIpc } from './ipc/portTraffic.ipc'
import { registerForwardIpc } from './ipc/forward.ipc'
import { registerHistoryIpc } from './ipc/history.ipc'
import { registerEditorIpc } from './ipc/editor.ipc'
import { closeEditorWindowIfOpen, requestEditorCloseForQuit } from './editorWindow'
import { registerSavedRefsIpc } from './ipc/savedRefs.ipc'
import { registerUpdateIpc } from './ipc/update.ipc'
import { registerSyncIpc } from './ipc/sync.ipc'
import { registerRdpIpc } from './ipc/rdp.ipc'
import { registerAiIpc } from './ipc/ai.ipc'
import { monitorManager } from './monitor/MonitorManager'
import { portTrafficManager } from './monitor/PortTrafficManager'
import { forwardManager } from './forward/ForwardManager'
import { lanSyncManager } from './lansync/LanSyncManager'
import { flushForwards } from './store/forwards'
import { packTempDir, transferQueue } from './sftp/TransferQueue'
import { sshManager } from './ssh/SshConnectionManager'
import { rdpSessionManager } from './rdp/RdpSessionManager'
import { closeDatabase } from './store/Database'
import { encryptExistingRowsOnce } from './store/encryptMigration'
import { flushConnections, migrateInlineRefsOnce } from './store/connections'
import { flushSavedRefs } from './store/savedRefs'
import { flushSnippets } from './store/snippets'
import { flushKnownHosts } from './ssh/hostkeys'
import { vault } from './store/Vault'
import { createMainWindow } from './window'
import { startUpdateChecks, stopUpdateChecks, updateActivity, updateState, checkForUpdate, downloadUpdate, installUpdate } from './services/updater'


import { instanceCoordinator, startInstanceCoordinator } from './instances/service'
import { multiInstanceAvailable, multiInstanceSupported, refreshNewWindowTask } from './instances/newWindowPolicy'
import { cancelAllAi } from './services/aiService'
import { metaSet } from './store/Database'
import { configureInstanceStorage, finishStorageBootstrap, releaseStorageBootstrap } from './instances/storage'

const instance = currentInstance
let storageStartupError: Error | undefined
try { configureInstanceStorage() } catch (error) {
  storageStartupError = error instanceof Error ? error : new Error('实例存储初始化失败。')
  releaseStorageBootstrap()
}
initLogger()
bindInstance(instance)

async function launchNewInstance(): Promise<void> {
  if (!multiInstanceSupported()) throw new Error('当前平台尚未开放多窗口。')
  if (!multiInstanceAvailable()) throw new Error('多实例已关闭，请在“设置 → 常规”中开启。')
  instanceCoordinator?.assertCanStart()
  const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--new-instance', `--user-data-dir=${app.getPath('userData')}`]
  const before = new Set(instanceCoordinator?.snapshot().map((m) => m.id))
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true })
    child.once('error', () => reject(new Error('新窗口启动失败，请检查应用文件是否完整。')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (instanceCoordinator?.snapshot().some((m) => !before.has(m.id))) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('新窗口未完成启动，请检查启动错误提示或诊断日志。')
}

function launchFromMenu(): void {
  void launchNewInstance().catch((error: Error) => dialog.showErrorBox('打开新窗口失败', error.message))
}

function installApplicationMenu(): void {
  if (process.platform !== 'darwin') {
    refreshNewWindowTask()
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = [
    { label: app.getName(), submenu: [
      { role: 'about' }, { type: 'separator' }, { role: 'services' },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' },
      { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }
    ] },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' },
    { role: 'windowMenu' }, { role: 'help' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function bindMainWindowLifecycle(win: BrowserWindow): void {
  win.on('closed', () => closeEditorWindowIfOpen())
  win.webContents.on('before-input-event', (event, input) => {
    if (multiInstanceAvailable() && input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'n') {
      event.preventDefault()
      launchFromMenu()
    }
  })
}

process.on('uncaughtException', (err) => logger.error('uncaughtException', err))
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason))

// The lock remains tied to shared userData; renderer partitions are process-specific.
let explicitNewInstance = false
const unsupportedNewInstance = instance.isExplicitNewInstance && !multiInstanceSupported()
try {
  if (!storageStartupError) explicitNewInstance = instance.isExplicitNewInstance && multiInstanceAvailable()
} catch (error) {
  storageStartupError = error instanceof Error ? error : new Error('配置读取失败。')
}
const ownsSingleInstanceLock = !storageStartupError && !unsupportedNewInstance && (explicitNewInstance || app.requestSingleInstanceLock())
if (!ownsSingleInstanceLock) {
  if (storageStartupError) void app.whenReady().then(() => {
    dialog.showErrorBox('OpenFinalShell 启动失败', storageStartupError!.message)
    closeDatabase()
    app.quit()
  })
  else if (unsupportedNewInstance) void app.whenReady().then(() => {
    dialog.showErrorBox('新窗口尚未开放', '当前发行包或平台尚未通过多实例完整验收，保持单实例模式。')
    app.quit()
  })
  else app.quit()
} else {
  logger.info(`instance started id=${instance.instanceId} pid=${process.pid} explicitNewInstance=${explicitNewInstance}`)
  let quitCleanupStarted = false
  let quitCleanupComplete = false
  let windowCreationReady = false

  const focusMainWindow = (): void => {
    if (!instance.mainWindow && windowCreationReady && !instance.closing) bindMainWindowLifecycle(createMainWindow(instance))
    const win = instance.mainWindow
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }
  app.on('second-instance', focusMainWindow)

  try {
    if (getSettings().disableGpu) app.disableHardwareAcceleration()
  } catch (error) {
    storageStartupError = error instanceof Error ? error : new Error('配置读取失败。')
  }

  void app.whenReady().then(async () => {
    if (storageStartupError) throw storageStartupError
    await finishStorageBootstrap()
    installApplicationMenu()
    if (process.argv.includes('--updated')) metaSet('instance_install_until', '0')
    await startInstanceCoordinator({
      onFocus: focusMainWindow,
      activity: updateActivity,
      update: async (op, force) => {
        if (op === 'state') return updateState()
        if (op === 'check') return checkForUpdate()
        if (op === 'download') return downloadUpdate()
        return installUpdate(force)
      },
      prepareExit: async () => {
        if (!await requestEditorCloseForQuit()) throw new Error('编辑器仍有未处理的更改，退出已取消。')
        setImmediate(() => app.quit())
      }
    })
    if ((!explicitNewInstance || !multiInstanceAvailable()) && !instanceCoordinator?.isLeader) {
      await instanceCoordinator?.focusLeader()
      app.quit()
      return
    }
    handle('app:newWindow', () => launchNewInstance())
    handle('app:instanceInfo', () => ({ instanceId: instance.instanceId, pid: process.pid, multiInstanceSupported: multiInstanceSupported(), canOpenNewWindow: multiInstanceAvailable() }))

    migrateInlineRefsOnce()
    encryptExistingRowsOnce()

    registerAppIpc()
    registerSettingsIpc()
    registerConnIpc()
    registerSessionIpc()
    registerTermIpc()
    registerSnippetIpc()
    registerSftpIpc()
    registerMonitorIpc()
    registerPortTrafficIpc()
    registerForwardIpc()
    registerHistoryIpc()
    registerSavedRefsIpc()
    registerUpdateIpc()
    registerEditorIpc()
    registerSyncIpc()
    registerRdpIpc()
    registerAiIpc()
    windowCreationReady = true

    // This directory belongs exclusively to this UUID; never remove another process's files.
    void rm(packTempDir(), { recursive: true, force: true }).catch(() => {})
    bindMainWindowLifecycle(createMainWindow(instance))
    startUpdateChecks()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) bindMainWindowLifecycle(createMainWindow(instance))
    })
  }).catch((error: Error) => {
    logger.error('instance startup failed', error)
    dialog.showErrorBox('OpenFinalShell 启动失败', error.message)
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitCleanupComplete) return
    event.preventDefault()
    if (quitCleanupStarted) return
    quitCleanupStarted = true

    void (async () => {
      if (!await requestEditorCloseForQuit()) { quitCleanupStarted = false; return }
      instance.closing = true
      stopUpdateChecks()
      cancelAllAi()
      transferQueue.cancelAll()
      monitorManager.stopAll()
      portTrafficManager.stopAll()
      forwardManager.stopAll()
      lanSyncManager.stopAll()
      sshManager.closeAll()
      await rdpSessionManager.closeAll()
      await transferQueue.waitForIdle()
      await instanceCoordinator?.stop()
      await rm(packTempDir(), { recursive: true, force: true }).catch(() => {})
      await Promise.all([settingsStore().flush(), flushConnections(), flushSavedRefs(),
        flushKnownHosts(), flushSnippets(), flushForwards(), vault.flush()])
      closeDatabase()
      releaseStorageBootstrap()
      quitCleanupComplete = true
      app.quit()
    })().catch((error) => {
      logger.error('instance cleanup failed', error)
      quitCleanupStarted = false
      instance.closing = false
      dialog.showErrorBox('退出未完成', '会话资源尚未全部释放，请重试退出。')
    })
  })
}
