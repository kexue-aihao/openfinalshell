import { useMemo } from 'react'
import { App as AntdApp, Button, Empty, Progress, Tooltip } from 'antd'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TransferTask } from '@shared/types'
import { TRANSFER_FINAL_STATES } from '@shared/constants'
import { ofs } from '@/ipc/api'
import { useTransferStore } from '@/stores/useTransferStore'
import { useElementHeight } from '@/hooks/useElementSize'
import { formatBytes, formatDuration, formatSpeed } from '@/utils/format'
import {
  buildTransferView,
  etaFrom,
  snapOf,
  type ProgressMap,
  type RowHeights,
  type TransferGroup,
  type TransferRow
} from './aggregate'
import { VirtualRows } from './VirtualRows'
import styles from './TransferList.module.css'

const STATE_KEY: Record<TransferTask['state'], string> = {
  queued: 'transfer.stateQueued',
  running: 'transfer.stateRunning',
  paused: 'transfer.statePaused',
  done: 'transfer.stateDone',
  error: 'transfer.stateError',
  canceled: 'transfer.stateCanceled',
  skipped: 'transfer.stateSkipped'
}

const GROUP_STATE_KEY: Record<TransferGroup['state'], string> = {
  queued: 'transfer.stateQueued',
  running: 'transfer.stateRunning',
  paused: 'transfer.statePaused',
  done: 'transfer.stateDone',
  partial: 'transfer.groupStatePartial'
}

/**
 * 打包传输的阶段名。有阶段时显示它**代替**状态名 —— "运行中"对一条打包任务几乎没有信息量，
 * 而"正在打包 / 正在解包"回答的正是用户此刻的疑问："进度条不动了，它在干什么？"
 *
 * 打包与解包阶段的进度**真的未知**（远端 tar 不吐进度，本地 tar 也不吐），
 * 所以进度条就停在上次的百分比，由阶段名承载"它在动"这个信息 —— **不许编百分比**。
 */
const PHASE_KEY: Record<NonNullable<TransferTask['phase']>, string> = {
  scanning: 'transfer.phaseScanning',
  packing: 'transfer.phasePacking',
  transferring: 'transfer.phaseTransferring',
  extracting: 'transfer.phaseExtracting',
  cleanup: 'transfer.phaseCleanup'
}

const FINISHED = TRANSFER_FINAL_STATES

/**
 * 行高必须是**定值**，窗口化才算得出偏移。这几个数不是拍的，是量出来的，
 * 而且能逐项对上 CSS（所有带子在 TransferList.module.css 里都钉了高度）：
 *
 *   顶层行 = 边框 2 + 内边距 16 + 标题 20 + 间隔 4 + 进度 10 + 间隔 2 + 底栏 24 = 78
 *   子行   = 边框 2 + 内边距  8 + （同上 60）                                   = 70
 *   宽幅顶层行再多一条路径：+ 16 + 4                                            = 98
 *
 * ⚠️ 改 CSS 里任何一条带子的高度，这里必须跟着改。对不上的表现是行被裁掉一截
 * 或者行之间出现缝隙 —— 打包冒烟里会量一次真实行高兜底。
 */
const ROW_H: Record<'compact' | 'wide', RowHeights> = {
  compact: { group: 78, child: 70, single: 78 },
  wide: { group: 78, child: 70, single: 98 }
}

/**
 * 行数少于这个数就直接平铺，一行虚拟化代码都不经过。
 *
 * 1–20 条任务是绝对多数场景；顺便给"容器高度还没量到"那一帧一个正确的兜底
 * （viewportHeight 为 0 时虚拟化会一行都渲染不出来）。
 */
const VIRTUAL_ROW_THRESHOLD = 60

/** 传输任务列表（抽屉与侧栏共用） */
export function TransferList({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const { message, modal } = AntdApp.useApp()
  const tasks = useTransferStore((s) => s.tasks)
  const progress = useTransferStore((s) => s.progress)
  const expandedGroups = useTransferStore((s) => s.expandedGroups)
  const toggleGroup = useTransferStore((s) => s.toggleGroup)
  const control = useTransferStore((s) => s.control)
  const controlAll = useTransferStore((s) => s.controlAll)
  const clearFinished = useTransferStore((s) => s.clearFinished)
  const [listRef, viewportHeight] = useElementHeight<HTMLDivElement>()

  const rowH = compact ? ROW_H.compact : ROW_H.wide
  /*
   * 每帧最多算一次：progress 走 rAF 合流，tasks 只在状态批时换引用 ——
   * 这两条纪律（在 useTransferStore 里）才是这个 useMemo 真的能拦住重算的原因。
   */
  const view = useMemo(
    () => buildTransferView(tasks, progress, expandedGroups, rowH),
    [tasks, progress, expandedGroups, rowH]
  )

  if (tasks.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('sidebar.emptyTransfers')}
        style={{ marginTop: 40 }}
      />
    )
  }

  const { rows, totals, offsets, totalHeight } = view
  const pct =
    totals.bytes > 0
      ? Math.min(100, Math.round((totals.transferred / totals.bytes) * 100))
      : 0
  // 分母还会变大时不给总 ETA（见 TransferTotals.unknownCount 的说明）
  const eta =
    totals.unknownCount === 0
      ? etaFrom(totals.bytes, totals.transferred, totals.upSpeed + totals.downSpeed)
      : null
  const hasLive = totals.runningCount > 0 || totals.doneCount < totals.totalCount

  const askCancelAll = (): void => {
    const pending = totals.totalCount - totals.doneCount - totals.failedCount
    modal.confirm({
      title: t('transfer.cancelAllConfirm', { count: pending }),
      okText: t('transfer.cancelAll'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () => void controlAll('cancel')
    })
  }

  const renderRow = (row: TransferRow, style: React.CSSProperties): React.ReactNode =>
    row.kind === 'group' ? (
      <GroupRow
        key={row.key}
        row={row}
        style={style}
        onToggle={() => toggleGroup(row.task.id)}
        onControl={(op) => void control(row.task.id, op)}
        t={t}
      />
    ) : (
      <TaskRow
        key={row.key}
        task={row.task}
        progress={progress}
        compact={compact}
        child={row.kind === 'child'}
        style={style}
        onControl={(op) => void control(row.task.id, op)}
        onOpenFolder={() =>
          void ofs
            .invoke('app:openPath', row.task.localPath)
            .catch(() => message.error(t('transfer.openFolderFailed')))
        }
        t={t}
      />
    )

  const virtual = rows.length > VIRTUAL_ROW_THRESHOLD && viewportHeight > 0

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div className={styles.headerTotals}>
          <span>
            {t('transfer.totalDone', { done: totals.doneCount, total: totals.totalCount })}
            {totals.failedCount > 0 && ` · ${t('transfer.totalFailed', { count: totals.failedCount })}`}
          </span>
          {/* key 不放进三元里：checkI18n 只认字面量，拼出来的 key 它扫不到 */}
          <span className="tabular-nums">
            {totals.unknownCount > 0
              ? t('transfer.totalBytesUnknown', {
                  transferred: formatBytes(totals.transferred),
                  total: formatBytes(totals.bytes)
                })
              : t('transfer.totalBytes', {
                  transferred: formatBytes(totals.transferred),
                  total: formatBytes(totals.bytes)
                })}
          </span>
          {totals.downSpeed > 0 && (
            <span className="tabular-nums">↓ {formatSpeed(totals.downSpeed)}</span>
          )}
          {totals.upSpeed > 0 && <span className="tabular-nums">↑ {formatSpeed(totals.upSpeed)}</span>}
          {eta !== null && (
            <span className="tabular-nums">
              {t('transfer.remaining', { time: formatDuration(eta) })}
            </span>
          )}
        </div>
        <div className={styles.headerActions}>
          {!compact && hasLive && (
            <>
              <Button size="small" type="text" onClick={() => void controlAll('pause')}>
                {t('transfer.pauseAll')}
              </Button>
              <Button size="small" type="text" danger onClick={askCancelAll}>
                {t('transfer.cancelAll')}
              </Button>
            </>
          )}
          <Button size="small" type="text" onClick={() => void clearFinished()}>
            {t('transfer.clearFinished')}
          </Button>
        </div>
      </div>

      {totals.bytes > 0 && (
        <Progress
          className={styles.totalBar}
          percent={pct}
          size="small"
          showInfo={false}
          status={totals.runningCount > 0 ? 'active' : 'normal'}
        />
      )}

      {/*
        高度观测点固定在这一层，两种形态都挂在它里面 —— 于是 ref 永远不会因为
        切换虚拟化而丢掉（丢了就再也量不到高度，也就再也回不到虚拟化）。
        它自己不滚：滚动权归内层，否则两层都能滚就是双滚动条。
      */}
      <div className={styles.listHost} ref={listRef}>
        {virtual ? (
          <VirtualRows
            rows={rows}
            offsets={offsets}
            totalHeight={totalHeight}
            heightOf={(i) => rowH[rows[i].kind]}
            viewportHeight={viewportHeight}
            renderRow={renderRow}
          />
        ) : (
          <div className={styles.list}>{rows.map((row) => renderRow(row, {}))}</div>
        )}
      </div>
    </div>
  )
}

type TFn = (key: string, opts?: Record<string, unknown>) => string
type Op = 'pause' | 'resume' | 'cancel' | 'retry'

function GroupRow({
  row,
  style,
  onToggle,
  onControl,
  t
}: {
  row: Extract<TransferRow, { kind: 'group' }>
  style: React.CSSProperties
  onToggle: () => void
  onControl: (op: Op) => void
  t: TFn
}): React.JSX.Element {
  const { task, group, expanded } = row
  const pct = group.bytes > 0 ? Math.min(100, Math.round((group.transferred / group.bytes) * 100)) : 0
  const live = !FINISHED.has(task.state)
  return (
    <div className={`${styles.item} ${styles.groupRow}`} style={style}>
      <div className={styles.itemTop}>
        <button
          type="button"
          className={styles.chevron}
          onClick={onToggle}
          aria-label={expanded ? t('transfer.collapse') : t('transfer.expand')}
        >
          {expanded ? (
            <ChevronDown size={13} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={13} strokeWidth={1.75} />
          )}
        </button>
        <span className={styles.itemName} title={`${task.localPath} ↔ ${task.remotePath}`}>
          {task.remotePath.split('/').pop()}
        </span>
        <span className={styles.itemState}>
          {task.phase && task.state === 'running'
            ? t(PHASE_KEY[task.phase])
            : t('transfer.groupProgress', { done: group.doneCount, total: group.totalCount })}
        </span>
        {group.failedCount > 0 && (
          <span className={styles.itemError}>
            {t('transfer.groupFailed', { count: group.failedCount })}
          </span>
        )}
        {task.skippedLinks ? (
          <span className={styles.itemState}>
            {t('transfer.groupSkippedLinks', { count: task.skippedLinks })}
          </span>
        ) : null}
        {group.speedBps > 0 && (
          <span className={`${styles.itemState} tabular-nums`}>{formatSpeed(group.speedBps)}</span>
        )}
        {live && (
          <Tooltip title={t('transfer.cancelGroup')}>
            <Button
              size="small"
              type="text"
              danger
              icon={<X size={13} strokeWidth={1.75} />}
              onClick={() => onControl('cancel')}
            />
          </Tooltip>
        )}
        {task.state === 'error' && (
          <Tooltip title={t('common.retry')}>
            <Button
              size="small"
              type="text"
              icon={<RotateCcw size={13} strokeWidth={1.75} />}
              onClick={() => onControl('retry')}
            />
          </Tooltip>
        )}
      </div>
      <Progress
        percent={group.state === 'done' ? 100 : pct}
        size="small"
        showInfo={false}
        status={
          group.state === 'partial' ? 'exception' : group.state === 'done' ? 'success' : 'active'
        }
      />
      <div className={styles.itemBottom}>
        <span className="tabular-nums">
          {formatBytes(group.transferred)} / {formatBytes(group.bytes)}
          {group.unknownCount > 0 && '+'}
        </span>
        <span className={styles.itemState}>{t(GROUP_STATE_KEY[group.state])}</span>
      </div>
    </div>
  )
}

function TaskRow({
  task,
  progress,
  compact,
  child,
  style,
  onControl,
  onOpenFolder,
  t
}: {
  task: TransferTask
  progress: ProgressMap
  compact: boolean
  child: boolean
  style: React.CSSProperties
  onControl: (op: Op) => void
  onOpenFolder: () => void
  t: TFn
}): React.JSX.Element {
  const snap = snapOf(task, progress)
  const pct = snap.size > 0 ? Math.min(100, Math.round((snap.transferred / snap.size) * 100)) : 0
  const eta = etaFrom(snap.size, snap.transferred, snap.speedBps)
  const finished = FINISHED.has(task.state)
  // notice 与 error 共用一行且互斥：行高固定，撑不出第二行来
  const aside = task.error ?? task.notice

  return (
    <div className={`${styles.item} ${child ? styles.childRow : ''}`} style={style}>
      <div className={styles.itemTop}>
        {task.kind === 'upload' ? (
          <ArrowUp size={13} strokeWidth={1.75} color="var(--ofs-accent)" />
        ) : (
          <ArrowDown size={13} strokeWidth={1.75} color="var(--ofs-success)" />
        )}
        <span className={styles.itemName} title={`${task.localPath} ↔ ${task.remotePath}`}>
          {task.remotePath.split('/').pop()}
        </span>
        {aside && (
          <Tooltip title={aside}>
            <span className={task.error ? styles.itemError : styles.itemNotice}>{aside}</span>
          </Tooltip>
        )}
        <span className={styles.itemState}>
          {task.phase && task.state === 'running'
            ? t(PHASE_KEY[task.phase])
            : t(STATE_KEY[task.state])}
        </span>
      </div>

      {!compact && !child && (
        <div
          className={styles.itemPath}
          title={task.kind === 'upload' ? task.localPath : task.remotePath}
        >
          {task.kind === 'upload'
            ? `${task.localPath} → ${task.remotePath}`
            : `${task.remotePath} → ${task.localPath}`}
        </div>
      )}

      <Progress
        percent={task.state === 'done' ? 100 : pct}
        size="small"
        showInfo={false}
        status={task.state === 'error' ? 'exception' : task.state === 'done' ? 'success' : 'active'}
      />

      <div className={styles.itemBottom}>
        <span className="tabular-nums">
          {snap.size >= 0
            ? `${formatBytes(snap.transferred)} / ${formatBytes(snap.size)}`
            : formatBytes(snap.transferred)}
        </span>
        {task.state === 'running' && (
          <span className="tabular-nums">
            {formatSpeed(snap.speedBps)}
            {eta !== null && ` · ${t('transfer.remaining', { time: formatDuration(eta) })}`}
          </span>
        )}
        <span className={styles.spacer} />
        {task.state === 'running' && (
          <Tooltip title={t('transfer.pause')}>
            <Button
              size="small"
              type="text"
              icon={<Pause size={13} strokeWidth={1.75} />}
              onClick={() => onControl('pause')}
            />
          </Tooltip>
        )}
        {task.state === 'paused' && (
          <Tooltip title={t('transfer.resume')}>
            <Button
              size="small"
              type="text"
              icon={<Play size={13} strokeWidth={1.75} />}
              onClick={() => onControl('resume')}
            />
          </Tooltip>
        )}
        {(task.state === 'error' || task.state === 'canceled') && (
          <Tooltip title={t('common.retry')}>
            <Button
              size="small"
              type="text"
              icon={<RotateCcw size={13} strokeWidth={1.75} />}
              onClick={() => onControl('retry')}
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
              onClick={() => onControl('cancel')}
            />
          </Tooltip>
        )}
        {task.state === 'done' && task.kind === 'download' && (
          <Tooltip title={t('transfer.openFolder')}>
            <Button
              size="small"
              type="text"
              icon={<FolderOpen size={13} strokeWidth={1.75} />}
              onClick={onOpenFolder}
            />
          </Tooltip>
        )}
      </div>
    </div>
  )
}
