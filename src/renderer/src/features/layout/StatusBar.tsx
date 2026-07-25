import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppVersions } from '@shared/types'
import { ofs } from '@/ipc/api'
import { useSessionStore } from '@/stores/useSessionStore'
import styles from './StatusBar.module.css'

export function StatusBar(): React.JSX.Element {
  const { t } = useTranslation()
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const active = tabs.find((tab) => tab.id === activeTabId)
  const [versions, setVersions] = useState<AppVersions | null>(null)

  useEffect(() => {
    void ofs.invoke('app:getVersions').then(setVersions)
  }, [])

  const connected = active?.state === 'ready'

  return (
    <footer className={styles.statusBar}>
      <span className={styles.item}>
        <span className={`${styles.dot} ${connected ? styles.dotConnected : ''}`} />
        {active ? (active.customTitle ?? active.title) : t('status.notConnected')}
      </span>
      <span className={styles.spacer} />
      {versions && (
        <span className={`${styles.item} tabular-nums`}>
          {t('status.version')} {versions.app} · Electron {versions.electron}
        </span>
      )}
    </footer>
  )
}
