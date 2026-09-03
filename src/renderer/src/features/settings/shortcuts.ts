/** 快捷键总表（v1 只读展示；改键列 v1.5）。macOS 使用 Cmd/Option 语义。 */
const isMac =
  typeof navigator !== 'undefined' &&
  /mac/i.test(
    [
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform,
      navigator.platform,
      navigator.userAgent
    ]
      .filter(Boolean)
      .join(' ')
  )
const primary = isMac ? 'Cmd' : 'Ctrl'
const option = isMac ? 'Option' : 'Alt'

export const SHORTCUTS: Array<{ keys: string; descKey: string }> = [
  { keys: `${primary} + Shift + T`, descKey: 'shortcut.duplicateSession' },
  { keys: `${primary} + W`, descKey: 'shortcut.closeTab' },
  { keys: `${primary} + Tab`, descKey: 'shortcut.nextTab' },
  { keys: `${primary} + Shift + Tab`, descKey: 'shortcut.prevTab' },
  { keys: `${option} + 1…9`, descKey: 'shortcut.gotoTab' },
  { keys: `${primary} + F`, descKey: 'shortcut.search' },
  { keys: `${primary} + Shift + H`, descKey: 'shortcut.history' },
  { keys: `${primary} + Shift + C`, descKey: 'shortcut.copy' },
  { keys: `${primary} + Shift + V / ${primary} + V`, descKey: 'shortcut.paste' },
  { keys: `${primary} + C`, descKey: 'shortcut.sigint' },
  { keys: 'F2', descKey: 'shortcut.renameFile' },
  { keys: 'Esc', descKey: 'shortcut.closeOverlay' }
]
