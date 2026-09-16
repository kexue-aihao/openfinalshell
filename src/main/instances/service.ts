import { app } from 'electron'
import { currentInstance } from '../instance'
import { broadcast, emit } from '../ipc/registry'
import { getSettings } from '../services/settings'
import { applyWindowChrome } from '../window'
import { applyEditorWindowChrome } from '../editorWindow'
import { InstanceCoordinator, type CoordinatorOptions } from './InstanceCoordinator'

export let instanceCoordinator: InstanceCoordinator | undefined

export async function startInstanceCoordinator(options: Pick<CoordinatorOptions, 'activity' | 'update' | 'prepareExit' | 'onFocus'>): Promise<void> {
  instanceCoordinator = new InstanceCoordinator({
    ...options,
    id: currentInstance.instanceId,
    version: app.getVersion(),
    onUpdateState: (state) => emit('update:state', state),
    onLeader: (leader) => {
      // After the original default process exits, an explicit instance can own the ordinary-launch lock.
      if (leader && !app.hasSingleInstanceLock()) app.requestSingleInstanceLock()
    },
    onConfig: (change) => {
      if (currentInstance.closing) return
      if (change.entity === 'settings') {
        const next = getSettings()
        applyWindowChrome(next)
        applyEditorWindowChrome(next)
        broadcast('settings:changed', next)
      }
      broadcast('app:configChanged', change)
    }
  })
  await instanceCoordinator.start()
}

/** macOS/Linux remain single-instance until their build and native-window acceptance completes. */
export function multiInstanceAvailable(): boolean {
  // Keep packaged builds single-instance until native Windows RDP/update acceptance is signed off.
  return process.platform === 'win32' && (!app.isPackaged || process.env.OFS_MULTI_INSTANCE_PREVIEW === '1')
}
