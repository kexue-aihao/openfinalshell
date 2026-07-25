import { useEffect, useMemo, useState } from 'react'
import { Button, Empty, Tooltip } from 'antd'
import { ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MonitorSnapshot } from '@shared/types'
import { historyOf, useMonitorStore } from '@/stores/useMonitorStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { SessionTab } from '@/stores/useSessionStore'
import { EChart } from '@/components/EChart'
import { formatBytes, formatDuration } from '@/utils/format'
import { areaOption, dualLineOption } from './charts'
import styles from './MonitorPanel.module.css'

interface Props {
  tab: SessionTab
  onClose: () => void
}

function usePct(used: number, total: number): number {
  return total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0
}

/** 占用条：>90% 变红，>75% 变黄 */
function usageColor(pct: number, accent: string): string {
  if (pct >= 90) return 'var(--ofs-error)'
  if (pct >= 75) return 'var(--ofs-warning)'
  return accent
}

export function MonitorPanel({ tab, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const settings = useSettingsStore((s) => s.settings)!
  const accent = settings.accent
  const sessionId = tab.sessionId
  const snapshot = useMonitorStore((s) => (sessionId ? s.latest[sessionId] : undefined))
  const staticInfo = useMonitorStore((s) => (sessionId ? s.staticInfo[sessionId] : undefined))
  const state = useMonitorStore((s) => (sessionId ? s.state[sessionId] : undefined))
  const start = useMonitorStore((s) => s.start)
  const [showCores, setShowCores] = useState(false)
  const [showProcs, setShowProcs] = useState(false)

  // 会话就绪 → 启动采集；关闭面板时由父组件调 stop
  useEffect(() => {
    if (!sessionId || tab.state !== 'ready') return
    void start(sessionId, settings.monitor.intervalMs).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tab.state, tab.shellEpoch])

  const history = sessionId ? historyOf(sessionId) : { cpu: [], memPct: [], rxBps: [], txBps: [] }

  const cpuOption = useMemo(
    () => areaOption([...history.cpu], accent),
    // 依赖最新快照的时间戳：每来一帧就重算 option
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot?.ts, accent]
  )
  const memOption = useMemo(
    () => areaOption([...history.memPct], '#13c2c2'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot?.ts]
  )
  const netOption = useMemo(
    () => dualLineOption([...history.rxBps], [...history.txBps], accent, '#faad14', formatBytes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot?.ts, accent]
  )

  const header = (
    <div className={styles.header}>
      <span>{t('monitor.title')}</span>
      <span style={{ display: 'flex', gap: 2 }}>
        {state === 'failed' && (
          <Tooltip title={t('common.retry')}>
            <Button
              size="small"
              type="text"
              icon={<RefreshCw size={13} strokeWidth={1.75} />}
              onClick={() => sessionId && void start(sessionId, settings.monitor.intervalMs)}
            />
          </Tooltip>
        )}
        <Button size="small" type="text" icon={<X size={13} strokeWidth={1.75} />} onClick={onClose} />
      </span>
    </div>
  )

  if (state === 'unsupported') {
    return (
      <div className={styles.panel}>
        {header}
        <div className={styles.stateBox}>{t('monitor.unsupported')}</div>
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <div className={styles.panel}>
        {header}
        <div className={styles.stateBox}>{t('monitor.failed')}</div>
      </div>
    )
  }
  if (!snapshot) {
    return (
      <div className={styles.panel}>
        {header}
        <div className={styles.stateBox}>
          {tab.state === 'ready' ? t('monitor.collecting') : t('monitor.waitingSession')}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      {header}
      <div className={styles.body}>
        {/* 系统信息 */}
        {staticInfo && (
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardHeadTitle}>{t('monitor.system')}</span>
            </div>
            <Kv k={t('monitor.hostname')} v={staticInfo.hostname} />
            <Kv k={t('monitor.distro')} v={staticInfo.distro} />
            <Kv k={t('monitor.kernel')} v={`${staticInfo.kernel} (${staticInfo.arch})`} />
            <Kv k={t('monitor.ip')} v={staticInfo.ips.join(', ') || '-'} />
            <Kv k={t('monitor.uptime')} v={formatDuration(snapshot.uptimeSec)} />
          </div>
        )}

        {/* CPU */}
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardHeadTitle}>CPU</span>
            <span className={styles.subText}>
              {t('monitor.load')} {snapshot.cpu.loadAvg.map((n) => n.toFixed(2)).join(' ')}
            </span>
            <span className={styles.cardToggle} onClick={() => setShowCores((v) => !v)}>
              {showCores ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </div>
          <div className={styles.bigNumber}>
            {snapshot.cpu.usagePct.toFixed(1)}
            <span className={styles.unit}>%</span>
          </div>
          <EChart option={cpuOption} height={48} />
          {showCores && (
            <div className={styles.coreGrid}>
              {snapshot.cpu.perCore.map((pct, i) => (
                <div key={i} className={styles.coreItem}>
                  <span>{i}</span>
                  <span className={styles.coreBar}>
                    <span
                      className={styles.barFill}
                      style={{ width: `${pct}%`, background: usageColor(pct, accent) }}
                    />
                  </span>
                  <span style={{ width: 30, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 内存 */}
        <MemCard snapshot={snapshot} accent={accent} option={memOption} />

        {/* 网络 */}
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardHeadTitle}>{t('monitor.network')}</span>
          </div>
          <div className={styles.netLegend}>
            <span className={styles.netItem}>
              <span style={{ color: accent }}>↓</span>
              <span className={styles.bigNumber} style={{ fontSize: 16 }}>
                {formatBytes(snapshot.net.reduce((s, n) => s + n.rxBps, 0))}
                <span className={styles.unit}>/s</span>
              </span>
            </span>
            <span className={styles.netItem}>
              <span style={{ color: '#faad14' }}>↑</span>
              <span className={styles.bigNumber} style={{ fontSize: 16 }}>
                {formatBytes(snapshot.net.reduce((s, n) => s + n.txBps, 0))}
                <span className={styles.unit}>/s</span>
              </span>
            </span>
          </div>
          <EChart option={netOption} height={48} />
        </div>

        {/* 磁盘 */}
        {snapshot.diskFs && snapshot.diskFs.length > 0 && (
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardHeadTitle}>{t('monitor.disk')}</span>
            </div>
            {snapshot.diskFs.map((fs) => (
              <div key={fs.mount} style={{ marginBottom: 6 }}>
                <div className={styles.kvRow}>
                  <span className={styles.kvValue} title={`${fs.fs} → ${fs.mount}`}>
                    {fs.mount}
                  </span>
                  <span className={styles.subText}>
                    {formatBytes(fs.usedKb * 1024)} / {formatBytes(fs.totalKb * 1024)}
                  </span>
                </div>
                <div className={styles.bar}>
                  <span
                    className={styles.barFill}
                    style={{ width: `${fs.usePct}%`, background: usageColor(fs.usePct, accent) }}
                  />
                </div>
              </div>
            ))}
            {snapshot.diskIo.length > 0 && (
              <div className={styles.subText}>
                {snapshot.diskIo
                  .map(
                    (d) => `${d.dev} ↓${formatBytes(d.readBps)}/s ↑${formatBytes(d.writeBps)}/s`
                  )
                  .join(' · ')}
              </div>
            )}
          </div>
        )}

        {/* 进程 Top */}
        {snapshot.topProcs && snapshot.topProcs.length > 0 && (
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardHeadTitle}>{t('monitor.topProcs')}</span>
              <span className={styles.cardToggle} onClick={() => setShowProcs((v) => !v)}>
                {showProcs ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
            </div>
            {showProcs && (
              <>
                <div className={styles.procRow}>
                  <span className={styles.subText}>{t('monitor.procName')}</span>
                  <span className={`${styles.subText} ${styles.procNum}`}>CPU</span>
                  <span className={`${styles.subText} ${styles.procNum}`}>MEM</span>
                </div>
                {snapshot.topProcs.map((p) => (
                  <div key={p.pid} className={styles.procRow}>
                    <span className={styles.procName} title={`PID ${p.pid}`}>
                      {p.name}
                    </span>
                    <span className={styles.procNum}>{p.cpuPct.toFixed(1)}</span>
                    <span className={styles.procNum}>{p.memPct.toFixed(1)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {snapshot.net.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('monitor.noIface')} />
        )}
      </div>
    </div>
  )
}

function Kv({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className={styles.kvRow}>
      <span className={styles.kvKey}>{k}</span>
      <span className={styles.kvValue} title={v}>
        {v}
      </span>
    </div>
  )
}

function MemCard({
  snapshot,
  accent,
  option
}: {
  snapshot: MonitorSnapshot
  accent: string
  option: Parameters<typeof EChart>[0]['option']
}): React.JSX.Element {
  const { t } = useTranslation()
  const memPct = usePct(snapshot.mem.usedKb, snapshot.mem.totalKb)
  const swapPct = usePct(snapshot.mem.swapUsedKb, snapshot.mem.swapTotalKb)
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardHeadTitle}>{t('monitor.memory')}</span>
        <span className={styles.subText}>
          {formatBytes(snapshot.mem.usedKb * 1024)} / {formatBytes(snapshot.mem.totalKb * 1024)}
        </span>
      </div>
      <div className={styles.bigNumber}>
        {memPct.toFixed(1)}
        <span className={styles.unit}>%</span>
      </div>
      <div className={styles.bar}>
        <span
          className={styles.barFill}
          style={{ width: `${memPct}%`, background: usageColor(memPct, accent) }}
        />
      </div>
      {snapshot.mem.swapTotalKb > 0 && (
        <>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Swap</span>
            <span className={styles.subText}>
              {formatBytes(snapshot.mem.swapUsedKb * 1024)} /{' '}
              {formatBytes(snapshot.mem.swapTotalKb * 1024)}
            </span>
          </div>
          <div className={styles.bar}>
            <span
              className={styles.barFill}
              style={{ width: `${swapPct}%`, background: '#722ed1' }}
            />
          </div>
        </>
      )}
      <EChart option={option} height={40} />
    </div>
  )
}
