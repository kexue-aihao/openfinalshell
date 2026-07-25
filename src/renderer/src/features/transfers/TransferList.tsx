import { App as AntdApp, Button, Empty, Progress, Tooltip } from 'antd'
import { ArrowDown, ArrowUp, FolderOpen, Pause, Play, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TransferTask } from '@shared/types'
import { ofs } from '@/ipc/api'
import { etaSeconds, useTransferStore } from '@/stores/useTransferStore'
import { formatBytes, formatDuration, formatSpeed } from '@/utils/format'
import styles from './TransferList.module.css'

const STATE_KEY: Record<TransferTask['state'], string> = {
  queued: 'transfer.stateQueued',
  running: 'transfer.stateRunning',
  paused: 'transfer.statePaused',
  done: 'transfer.stateDone',
  error: 'transfer.stateError',
  canceled: 'transfer.stateCanceled'
}

/** 传输任务列表（抽屉与侧栏共用） */
export function TransferList({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const tasks = useTransferStore((s) => s.tasks)
  const control = useTransferStore((s) => s.control)
  const clearFinished = useTransferStore((s) => s.clearFinished)

  if (tasks.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('sidebar.emptyTransfers')}
        style={{ marginTop: 40 }}
      />
    )
  }

  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <span>{t('transfer.count', { count: tasks.length })}</span>
        <div className={styles.headerActions}>
          <Button size="small" type="text" onClick={() => void clearFinished()}>
            {t('transfer.clearFinished')}
          </Button>
        </div>
      </div>
      <div className={styles.list}>
        {sorted.map((task) => {
          const pct =
            task.size > 0 ? Math.min(100, Math.round((task.transferred / task.size) * 100)) : 0
          const eta = etaSeconds(task)
          const finished = ['done', 'error', 'canceled'].includes(task.state)
          return (
            <div key={task.id} className={styles.item}>
              <div className={styles.itemTop}>
                {task.kind === 'upload' ? (
                  <ArrowUp size={13} strokeWidth={1.75} color="var(--ofs-accent)" />
                ) : (
                  <ArrowDown size={13} strokeWidth={1.75} color="var(--ofs-success)" />
                )}
                <span className={styles.itemName} title={`${task.localPath} ↔ ${task.remotePath}`}>
                  {task.remotePath.split('/').pop()}
                </span>
                <span className={styles.itemState}>{t(STATE_KEY[task.state])}</span>
              </div>

              {!compact && (
                <div className={styles.itemPath} title={task.kind === 'upload' ? task.localPath : task.remotePath}>
                  {task.kind === 'upload'
                    ? `${task.localPath} → ${task.remotePath}`
                    : `${task.remotePath} → ${task.localPath}`}
                </div>
              )}

              <Progress
                percent={task.state === 'done' ? 100 : pct}
                size="small"
                showInfo={false}
                status={
                  task.state === 'error' ? 'exception' : task.state === 'done' ? 'success' : 'active'
                }
              />

              <div className={styles.itemBottom}>
                <span className="tabular-nums">
                  {task.size >= 0
                    ? `${formatBytes(task.transferred)} / ${formatBytes(task.size)}`
                    : formatBytes(task.transferred)}
                </span>
                {task.state === 'running' && (
                  <span className="tabular-nums">
                    {formatSpeed(task.speedBps)}
                    {eta !== null && ` · ${t('transfer.remaining', { time: formatDuration(eta) })}`}
                  </span>
                )}
                {task.error && <span className={styles.itemError}>{task.error}</span>}
                <span className={styles.spacer} />
                {task.state === 'running' && (
                  <Tooltip title={t('transfer.pause')}>
                    <Button
                      size="small"
                      type="text"
                      icon={<Pause size={13} strokeWidth={1.75} />}
                      onClick={() => void control(task.id, 'pause')}
                    />
                  </Tooltip>
                )}
                {task.state === 'paused' && (
                  <Tooltip title={t('transfer.resume')}>
                    <Button
                      size="small"
                      type="text"
                      icon={<Play size={13} strokeWidth={1.75} />}
                      onClick={() => void control(task.id, 'resume')}
                    />
                  </Tooltip>
                )}
                {(task.state === 'error' || task.state === 'canceled') && (
                  <Tooltip title={t('common.retry')}>
                    <Button
                      size="small"
                      type="text"
                      icon={<RotateCcw size={13} strokeWidth={1.75} />}
                      onClick={() => void control(task.id, 'retry')}
                    />
                  </Tooltip>
                )}
                {!finished && (
                  <Tooltip title={t('transfer.cancel')}>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<X size={13} strokeWidth={1.75} />}
                      onClick={() => void control(task.id, 'cancel')}
                    />
                  </Tooltip>
                )}
                {task.state === 'done' && task.kind === 'download' && (
                  <Tooltip title={t('transfer.openFolder')}>
                    <Button
                      size="small"
                      type="text"
                      icon={<FolderOpen size={13} strokeWidth={1.75} />}
                      onClick={() =>
                        void ofs
                          .invoke('app:openPath', task.localPath)
                          .catch(() => message.error(t('transfer.openFolderFailed')))
                      }
                    />
                  </Tooltip>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
