import { app, Menu } from 'electron'
import { getSettings } from '../services/settings'
import { scopedLogger } from '../utils/logger'
import { platformAcceptance } from '../services/platformCapabilities'

const log = scopedLogger('new-window')
let installedTaskState: boolean | undefined

export function multiInstanceSupported(): boolean {
  return platformAcceptance().multiInstance
}

export function multiInstanceAvailable(): boolean {
  return multiInstanceSupported() && getSettings().multiInstanceEnabled === true
}

/** The shared preference also controls taskbar entry points in already open instances. */
export function refreshNewWindowTask(): void {
  const menuItem = Menu.getApplicationMenu()?.getMenuItemById('ofs-new-window')
  if (menuItem) menuItem.enabled = multiInstanceAvailable()
  if (process.platform !== 'win32' || !multiInstanceSupported() || !app.isPackaged) return
  const enabled = multiInstanceAvailable()
  if (installedTaskState === enabled) return
  try {
    const result = app.setJumpList(enabled ? [{
      type: 'tasks',
      items: [{ type: 'task', title: '打开新窗口', description: '启动独立窗口',
        program: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
        args: '--new-instance', iconPath: process.execPath, iconIndex: 0 }]
    }] : [])
    if (result === 'ok') installedTaskState = enabled
    else log.warn(`Jump List registration failed: ${result}`)
  } catch {
    log.warn('Jump List registration failed')
  }
}
