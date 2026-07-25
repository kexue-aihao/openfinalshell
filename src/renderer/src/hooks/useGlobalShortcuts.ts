import { useEffect } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * 应用级快捷键。所有分支先检查 isComposing —— 中文输入法组词期间不得触发。
 * 终端内的 Ctrl+Shift+C/V、Ctrl+F 由 xterm 的 customKeyEventHandler 处理，不在此重复。
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return

      const { tabs, activeTabId, activateRelative, activateIndex, closeTab, duplicateTab } =
        useSessionStore.getState()

      // Ctrl+Tab / Ctrl+Shift+Tab：切换标签
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        activateRelative(e.shiftKey ? -1 : 1)
        return
      }

      // Alt+1..9：直达第 N 个标签
      if (e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        activateIndex(Number(e.key) - 1)
        return
      }

      // Ctrl+Shift+T：复制当前会话
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') {
        e.preventDefault()
        if (activeTabId) {
          void duplicateTab(activeTabId, useConnectionStore.getState().profiles)
        }
        return
      }

      // Ctrl+W：关闭当前标签（按设置决定是否确认）
      if (e.ctrlKey && !e.shiftKey && e.code === 'KeyW') {
        e.preventDefault()
        if (!activeTabId) return
        const settings = useSettingsStore.getState().settings
        const tab = tabs.find((t) => t.id === activeTabId)
        if (settings?.confirmOnCloseTab && tab?.state === 'ready') {
          if (!window.confirm(`关闭标签「${tab.customTitle ?? tab.title}」？`)) return
        }
        void closeTab(activeTabId)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
