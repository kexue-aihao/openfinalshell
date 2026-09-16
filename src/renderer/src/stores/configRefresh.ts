import { ofs } from '@/ipc/api'
import { useConnectionStore } from './useConnectionStore'
import { useSavedRefStore } from './useSavedRefStore'
import { useSettingsStore } from './useSettingsStore'
import { useSnippetStore } from './useSnippetStore'
import { useForwardStore } from './useForwardStore'

/** Refresh configuration snapshots only. Existing session/tab objects retain their runtime identity. */
export function wireConfigRefresh(): () => void {
  let busy = false
  const refresh = (): void => {
    if (busy) return
    busy = true
    void Promise.allSettled([
      useConnectionStore.getState().load(), useSavedRefStore.getState().load(),
      useSnippetStore.getState().load(), useForwardStore.getState().load(),
      ofs.invoke('settings:get').then((settings) => useSettingsStore.setState({ settings }))
    ]).finally(() => { busy = false })
  }
  const off = ofs.on('app:configChanged', refresh)
  window.addEventListener('focus', refresh)
  const timer = setInterval(refresh, 30_000)
  return () => { off(); window.removeEventListener('focus', refresh); clearInterval(timer) }
}
