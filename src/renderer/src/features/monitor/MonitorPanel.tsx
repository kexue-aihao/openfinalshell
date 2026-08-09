import { useEffect, useState } from 'react'
import { Button, Empty } from 'antd'
import { ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MonitorSnapshot } from '@shared/types'
import { historyOf, useMonitorStore } from '@/stores/useMonitorStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { SessionTab } from '@/stores/useSessionStore'
import { TitlebarSafeTooltip } from '@/components/TitlebarSafeTooltip'
import { formatBytes, formatDuration } from '@/utils/format'
import { MonitorGraph } from './MonitorGraph'
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

/** 延迟分档配色：<100 绿 / <200 黄 / 其余红（对齐 FinalShell 肌肉记忆） */
function latencyColor(ms: number): string {
  if (ms < 100) return '#52c41a'
  if (ms < 200) return '#faad14'
  return '#ff4d4f'
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

  const history = sessionId
    ? historyOf(sessionId)
    : { cpu: [], memPct: [], rxBps: [], txBps: [], latencyMs: [] }
  // 历史数组是原地 push/shift（引用不变），spread 成新数组让 MonitorGraph 的
  // useEffect 依赖能察觉变化；每帧一次、60 点小图，开销可忽略
  void snapshot?.ts // 依赖锚点：每来一帧本组件重渲染，下面几张图跟着重画

  const header = (
    <div className={styles.header}>
      <span>{t('monitor.title')}</span>
      <span style={{ display: 'flex', gap: 2 }}>
        {state === 'failed' && (
          <TitlebarSafeTooltip title={t('common.retry')}>
            <Button
              size="small"
              type="text"
              icon={<RefreshCw size={13} strokeWidth={1.75} />}
              onClick={() => sessionId && void start(sessionId, settings.monitor.intervalMs)}
            />
          </TitlebarSafeTooltip>
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
          <MonitorGraph primary={[...history.cpu]} height={48} max={100} className={styles.graph} />
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
        <MemCard snapshot={snapshot} accent={accent} memHistory={[...history.memPct]} />

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
          {/* 下行 = 渐变面积（绿→红按量），上行 = 橙线叠加，与图例配色一致 */}
          <MonitorGraph
            primary={[...history.rxBps]}
            secondary={[...history.txBps]}
            height={48}
            className={styles.graph}
          />
        </div>

        {/* 延迟：既有采集通道的往返毫秒（写帧 → 首见 BEGIN 哨兵），不另开连接 */}
        {snapshot.latencyMs !== undefined && (
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardHeadTitle}>{t('monitor.latency')}</span>
            </div>
            <div className={styles.bigNumber} style={{ color: latencyColor(snapshot.latencyMs) }}>
              {snapshot.latencyMs}
              <span className={styles.unit}>ms</span>
            </div>
            <MonitorGraph primary={[...history.latencyMs]} height={40} className={styles.graph} />
          </div>
        )}

        {/* 连接数。措辞上要分清：UDP 是无连接的，/proc/net/udp 列的是**已打开的套接字** */}
        {snapshot.conns && (
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardHeadTitle}>{t('monitor.conns')}</span>
              <span className={styles.subText}>
                {t('monitor.connsSockets')} {snapshot.conns.socketsUsed}
              </span>
            </div>
            <div className={styles.bigNumber}>
              {snapshot.conns.tcpInuse}
              <span className={styles.unit}>TCP</span>
            </div>
            {/* 状态明细只在低频 tick 采，缺失时不显示这几行（store 会沿用上次值） */}
            {snapshot.tcpStates &&
              (['ESTABLISHED', 'LISTEN', 'CLOSE_WAIT'] as const)
                .filter((name) => snapshot.tcpStates?.[name] !== undefined)
                .map((name) => (
                  <Kv key={name} k={name} v={String(snapshot.tcpStates?.[name] ?? 0)} />
                ))}
            {/* TIME_WAIT 用 sockstat 的 tw：它每 tick 都有，而明细每 5 tick 才刷 */}
            <Kv k="TIME_WAIT" v={String(snapshot.conns.tcpTw)} />
            {snapshot.conns.tcpOrphan > 0 && (
              <Kv k={t('monitor.connsOrphan')} v={String(snapshot.conns.tcpOrphan)} />
            )}
            <Kv k={t('monitor.connsUdp')} v={String(snapshot.conns.udpInuse)} />
          </div>
        )}

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
  memHistory
}: {
  snapshot: MonitorSnapshot
  accent: string
  memHistory: number[]
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
      <MonitorGraph primary={memHistory} height={40} max={100} className={styles.graph} />
    </div>
  )
}
