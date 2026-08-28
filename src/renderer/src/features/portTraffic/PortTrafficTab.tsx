import { useEffect } from 'react'
import { Button, Empty, Tag } from 'antd'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PortTrafficEntry } from '@shared/types'
import type { SessionTab } from '@/stores/useSessionStore'
import { usePortTrafficStore } from '@/stores/usePortTrafficStore'
import { formatSpeed, formatTimestamp } from '@/utils/format'
import styles from './PortTrafficTab.module.css'

interface Props {
  tab: SessionTab
}

function portState(entry: PortTrafficEntry): 'active' | 'idle' {
  return entry.rxBps + entry.txBps > 0 ? 'active' : 'idle'
}

/** 绑定已有 SSH 会话的端口流量工具页，不打开终端或创建第二个登录会话。 */
export function PortTrafficTab({ tab }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = tab.sessionId
  const snapshot = usePortTrafficStore((s) => (sessionId ? s.latest[sessionId] : undefined))
  const state = usePortTrafficStore((s) => (sessionId ? s.state[sessionId] : undefined))
  const error = usePortTrafficStore((s) => (sessionId ? s.error[sessionId] : undefined))
  const start = usePortTrafficStore((s) => s.start)

  useEffect(() => {
    if (!sessionId || tab.state !== 'ready') return
    void start(sessionId).catch(() => {})
  }, [sessionId, start, tab.state])

  if (state === 'unsupported') {
    return (
      <div className={styles.empty}>
        <Empty description={t('portTraffic.unsupported')} />
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <div className={styles.empty}>
        <Empty description={error || t('portTraffic.failed')}>
          <Button type="primary" icon={<RefreshCw size={15} />} onClick={() => sessionId && void start(sessionId)}>
            {t('common.retry')}
          </Button>
        </Empty>
      </div>
    )
  }
  if (!snapshot) {
    return <div className={styles.empty}>{t('portTraffic.collecting')}</div>
  }

  const totals = snapshot.ports.reduce<{ rx: number; tx: number; connections: number }>(
    (acc, port) => ({ rx: acc.rx + port.rxBps, tx: acc.tx + port.txBps, connections: acc.connections + port.connections }),
    { rx: 0, tx: 0, connections: 0 }
  )

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.title}>{t('portTraffic.title')}</div>
          <div className={styles.meta}>
            {t('portTraffic.updated', { time: formatTimestamp(snapshot.ts) })}
          </div>
        </div>
        <div className={styles.totals}>
          <span><b className={styles.down}>↓</b>{formatSpeed(totals.rx)}</span>
          <span><b className={styles.up}>↑</b>{formatSpeed(totals.tx)}</span>
          <span>{t('portTraffic.totalConnections', { count: totals.connections })}</span>
        </div>
      </header>

      <div className={styles.content}>
        {snapshot.ports.length === 0 ? (
          <Empty className={styles.noPorts} description={t('portTraffic.empty')} />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('portTraffic.port')}</th>
                  <th>{t('portTraffic.connections')}</th>
                  <th>{t('portTraffic.receive')}</th>
                  <th>{t('portTraffic.send')}</th>
                  <th>{t('portTraffic.status')}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.ports.map((entry) => (
                  <tr key={entry.port}>
                    <td className={styles.port}>{entry.port}</td>
                    <td>{entry.connections}</td>
                    <td className={styles.receive}>{formatSpeed(entry.rxBps)}</td>
                    <td className={styles.send}>{formatSpeed(entry.txBps)}</td>
                    <td>
                      <Tag color={portState(entry) === 'active' ? 'green' : 'default'}>
                        {portState(entry) === 'active'
                          ? t('portTraffic.active')
                          : t('portTraffic.idle')}
                      </Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.note}>{t('portTraffic.note')}</p>
      </div>
    </div>
  )
}
