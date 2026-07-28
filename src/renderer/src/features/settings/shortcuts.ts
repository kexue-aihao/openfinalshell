/** 快捷键总表（v1 只读展示；改键列 v1.5） */
export const SHORTCUTS: Array<{ keys: string; descKey: string }> = [
  { keys: 'Ctrl + Shift + T', descKey: 'shortcut.duplicateSession' },
  { keys: 'Ctrl + W', descKey: 'shortcut.closeTab' },
  { keys: 'Ctrl + Tab', descKey: 'shortcut.nextTab' },
  { keys: 'Ctrl + Shift + Tab', descKey: 'shortcut.prevTab' },
  { keys: 'Alt + 1…9', descKey: 'shortcut.gotoTab' },
  { keys: 'Ctrl + F', descKey: 'shortcut.search' },
  { keys: 'Ctrl + Shift + H', descKey: 'shortcut.history' },
  { keys: 'Ctrl + Shift + C', descKey: 'shortcut.copy' },
  { keys: 'Ctrl + Shift + V / Ctrl + V', descKey: 'shortcut.paste' },
  { keys: 'Ctrl + C', descKey: 'shortcut.sigint' },
  { keys: 'F2', descKey: 'shortcut.renameFile' },
  { keys: 'Esc', descKey: 'shortcut.closeOverlay' }
]
