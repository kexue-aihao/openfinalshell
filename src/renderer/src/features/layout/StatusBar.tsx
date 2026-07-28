import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppVersions } from '@shared/types'
import { ofs } from '@/ipc/api'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useTransferStore } from '@/stores/useTransferStore'
import { useUpdateStore } from '@/stores/useUpdateStore'
import { useUiStore } from '@/stores/useUiStore'
import { formatSpeed } from '@/utils/format'
import styles from './StatusBar.module.css'

export function StatusBar(): React.JSX.Element {
  const { t } = useTranslation()
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const active = tabs.find((tab) => tab.id === activeTabId)
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === active?.profileId))
  const tasks = useTransferStore((s) => s.tasks)
  const setDrawerOpen = useTransferStore((s) => s.setDrawerOpen)
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const update = useUpdateStore((s) => s.state)
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
  const ready = update?.status === 'downloaded'

  useEffect(() => {
    void ofs.invoke('app:getVersions').then(setVersions)
  }, [])

  const connected = active?.state === 'ready'
  const running = tasks.filter((task) => task.state === 'running')
  const upSpeed = running
    .filter((task) => task.kind === 'upload')
    .reduce((sum, task) => sum + task.speedBps, 0)
  const downSpeed = running
    .filter((task) => task.kind === 'download')
    .reduce((sum, task) => sum + task.speedBps, 0)

  return (
    <footer className={styles.statusBar}>
      <span className={styles.item}>
        <span className={`${styles.dot} ${connected ? styles.dotConnected : ''}`} />
        {active ? (active.customTitle ?? active.title) : t('status.notConnected')}
      </span>
      {profile && active && (
        <span className={styles.item}>
          {profile.username}@{profile.host}:{profile.port}
        </span>
      )}

      <span className={styles.spacer} />

      {running.length > 0 && (
        <span className={`${styles.item} ${styles.clickable} tabular-nums`} onClick={() => setDrawerOpen(true)}>
          <ArrowDown size={11} strokeWidth={2} />
          {formatSpeed(downSpeed)}
          <ArrowUp size={11} strokeWidth={2} />
          {formatSpeed(upSpeed)}
          <span>· {t('transfer.runningCount', { count: running.length })}</span>
        </span>
      )}
      {profile && <span className={styles.item}>{profile.terminal.charset.toUpperCase()}</span>}
      {versions && (
        /*
         * 更新就绪时整条变成可点的 —— 点开设置页的「关于」，那儿才有「重启并安装」。
         * 刻意不弹气泡：这个窗口里已经有终端、监控、传输三处在动，
         * 再冒一个"有新版"的浮层只会盖住用户正在看的东西。
         */
        <span
          className={`${styles.item} tabular-nums ${ready ? styles.clickable : ''}`}
          onClick={ready ? () => setSettingsOpen(true) : undefined}
          title={ready ? t('update.readyTag', { version: update?.version ?? '' }) : undefined}
        >
          {ready && <span className={styles.updateDot} />}
          {t('status.version')} {versions.app}
        </span>
      )}
    </footer>
  )
}
