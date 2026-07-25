import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import type { AppSettings } from '@shared/types'
import { resolveTerminalTheme } from '@/themes/terminal'
import styles from './SettingsModal.module.css'

const SAMPLE = [
  '\x1b[32mtest@web-01\x1b[0m:\x1b[34m~\x1b[0m$ ls -lh /var/log',
  '\x1b[1;34mdrwxr-xr-x\x1b[0m  4.0K \x1b[1;34mnginx\x1b[0m',
  '\x1b[0m-rw-r--r--\x1b[0m  1.2M \x1b[33msyslog\x1b[0m',
  '\x1b[31merror\x1b[0m \x1b[33mwarn\x1b[0m \x1b[32mok\x1b[0m \x1b[36minfo\x1b[0m 中文对齐测试 ✓'
].join('\r\n')

/** 终端配色实时预览：独立的小 xterm 实例，不联网也不接会话 */
export function TerminalPreview({
  themeId,
  settings
}: {
  themeId: string
  settings: AppSettings
}): React.JSX.Element {
  const elRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!elRef.current) return
    const term = new Terminal({
      cols: 64,
      rows: 5,
      fontFamily: settings.terminal.fontFamily,
      fontSize: 12,
      lineHeight: settings.terminal.lineHeight,
      cursorBlink: false,
      disableStdin: true,
      scrollback: 0,
      theme: resolveTerminalTheme(themeId, 'dark')
    })
    term.open(elRef.current)
    term.write(SAMPLE)
    termRef.current = term
    return () => {
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 配色/字体变化时热更新，无需重建实例
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = resolveTerminalTheme(themeId, 'dark')
    term.options.fontFamily = settings.terminal.fontFamily
    term.options.lineHeight = settings.terminal.lineHeight
  }, [themeId, settings.terminal.fontFamily, settings.terminal.lineHeight])

  return <div className={styles.preview} ref={elRef} />
}
