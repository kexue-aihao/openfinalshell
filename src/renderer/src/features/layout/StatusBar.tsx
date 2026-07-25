import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppVersions } from '@shared/types'
import { ofs } from '@/ipc/api'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useTransferStore } from '@/stores/useTransferStore'
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
        <span className={`${styles.item} tabular-nums`}>
          {t('status.version')} {versions.app}
        </span>
      )}
    </footer>
  )
}
