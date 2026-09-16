import { app } from 'electron'
import { currentInstance } from '../instance'
import { broadcast, emit } from '../ipc/registry'
import { getSettings } from '../services/settings'
import { applyWindowChrome } from '../window'
import { applyEditorWindowChrome } from '../editorWindow'
import { InstanceCoordinator, type CoordinatorOptions } from './InstanceCoordinator'
import { refreshNewWindowTask } from './newWindowPolicy'

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
        refreshNewWindowTask()
        applyWindowChrome(next)
        applyEditorWindowChrome(next)
        broadcast('settings:changed', next)
      }
      broadcast('app:configChanged', change)
    }
  })
  await instanceCoordinator.start()
}
