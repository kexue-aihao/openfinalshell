import { useEffect } from 'react'
import i18n from '@/i18n'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * 焦点是不是在一个"用户正在打字"的地方。
 *
 * 只有 Ctrl+W 用它，理由是那个组合在文本框里有**另一个天然含义**：readline/终端里
 * Ctrl+W 是"删除前一个词"，而在这里它会关掉整条 SSH 会话 —— 在 SFTP 的路径框、
 * 重命名框、设置页的输入框、以及内置编辑器的查找框里按下去，代价与预期完全不成比例。
 *
 * xterm 的隐藏 textarea 刻意**不算**文本框：终端里 Ctrl+W 一直是"关标签"，
 * 改成透传给 shell 是另一件事（要与 shell 的 delete-word 对齐，还得决定要不要拦），
 * 这次不动它 —— 一次修一个问题。
 */
function inTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.classList.contains('xterm-helper-textarea')) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

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

      // Ctrl+W：关闭当前标签（按设置决定是否确认）。文本框里让位，见 inTextEntry
      if (e.ctrlKey && !e.shiftKey && e.code === 'KeyW' && !inTextEntry(e.target)) {
        e.preventDefault()
        if (!activeTabId) return
        const settings = useSettingsStore.getState().settings
        const tab = tabs.find((t) => t.id === activeTabId)
        if (settings?.confirmOnCloseTab && tab?.state === 'ready') {
          if (!window.confirm(i18n.t('tab.closeConfirm', { title: tab.customTitle ?? tab.title })))
            return
        }
        void closeTab(activeTabId)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
