import { useEffect, useRef, useState } from 'react'
import { Alert, App as AntdApp, Button, Modal, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import type { ConflictProbeResult, SessionId, TransferConflictAction } from '@shared/types'
import { ofs } from '@/ipc/api'
import { formatBytes } from '@/utils/format'
import styles from './SftpPane.module.css'

/** 探测超过这个时长才把框显出来 —— 小目录几十毫秒完事，不该闪一下 */
const SLOW_PROBE_MS = 300
/** 只列前 N 条（与快速删除那个框同款） */
const LIST_LIMIT = 10

export interface UploadRequest {
  sessionId: SessionId
  targetDir: string
  localPaths: string[]
  /** 上传目标的基名，由调用方从 localPaths 推出来（main 只收基名，不收路径） */
  names: string[]
}

interface Props {
  request: UploadRequest | null
  onCancel: () => void
  /** action 为 undefined = 无冲突/未能探测，按用户的默认设置走 */
  onProceed: (action: TransferConflictAction | undefined) => void
}

/**
 * 上传前的同名冲突汇总框。
 *
 * 为什么用 `<Modal>` 而不是 `modal.confirm`：后者只有 ok/cancel 两个按钮，而这里要
 * 三选一；更要紧的是它天生没有"内容还没算出来"这个态 —— 而这个框要同时承载"正在探测"。
 *
 * 探测跑在**这个组件的 effect 里**，不在 SftpPane 里：这样"扫描中"与"三选一"是同一个
 * 组件的两个阶段，只有一个挂载点，也不会出现"扫描完了但界面上没有承接的地方"。
 */
export function UploadConflictModal({ request, onCancel, onProceed }: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const [result, setResult] = useState<ConflictProbeResult | null>(null)
  const [slow, setSlow] = useState(false)
  /*
   * 取消不能只靠"卸载后不 setState"：入队是**副作用**，回包到了照样会发出去。
   * 所以用一个 ref 明确标记"这一趟不算了"，回包直接丢弃。
   */
  const abortedRef = useRef(false)

  useEffect(() => {
    if (!request) return
    abortedRef.current = false
    setResult(null)
    setSlow(false)
    const timer = setTimeout(() => setSlow(true), SLOW_PROBE_MS)

    void ofs
      .invoke('transfer:probeConflicts', {
        sessionId: request.sessionId,
        targetDir: request.targetDir,
        names: request.names
      })
      .then((probe) => {
        if (abortedRef.current) return
        /*
         * 无冲突直接走，一个框都不弹。
         *
         * ⚠️ 这一句必须在任何"进入询问态"之前 —— 有护栏钉着顺序。传 undefined 而不是
         * 'overwrite'：没有冲突时不该替用户表达任何覆盖意愿（真到落地那一刻若冒出
         * 新的同名，该按他自己的默认设置处置）。
         *
         * probed === false 同样直通，但要如实说一声"没能检查" —— 把一次失败的探测
         * 显示成"无冲突"就是静默覆盖。
         */
        if (!probe.probed) {
          message.warning(t('sftp.uploadProbeFailed'))
          onProceed(undefined)
          return
        }
        if (probe.conflicts.length === 0) {
          onProceed(undefined)
          return
        }
        setResult(probe)
      })
      .catch(() => {
        if (abortedRef.current) return
        message.warning(t('sftp.uploadProbeFailed'))
        onProceed(undefined)
      })
      .finally(() => clearTimeout(timer))

    return () => {
      clearTimeout(timer)
    }
    // onProceed/onCancel 每次渲染都是新函数，进依赖会让探测反复重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  if (!request) return null
  const asking = result !== null
  // 探测阶段延迟显形：小目录一个框都不闪
  if (!asking && !slow) return null

  const cancel = (): void => {
    abortedRef.current = true
    onCancel()
  }
  const decide = (action: TransferConflictAction): void => {
    setResult(null)
    onProceed(action)
  }

  return (
    <Modal
      open
      width={640}
      maskClosable={false}
      title={
        asking
          ? t('sftp.conflictTitle', { count: result.conflicts.length })
          : t('sftp.uploadScanning')
      }
      onCancel={cancel}
      footer={
        asking
          ? [
              <Button key="cancel" onClick={cancel}>
                {t('common.cancel')}
              </Button>,
              <Button key="skip" onClick={() => decide('skip')}>
                {t('sftp.conflictSkipAll')}
              </Button>,
              <Button key="rename" onClick={() => decide('rename')}>
                {t('sftp.conflictRenameAll')}
              </Button>,
              // 唯一的 danger + primary，与快速删除那个框同一套视觉语言。
              // 刻意**不绑回车**：三选一里回车该落在哪个上没有安全答案
              <Button key="overwrite" type="primary" danger onClick={() => decide('overwrite')}>
                {t('sftp.conflictOverwriteAll')}
              </Button>
            ]
          : [
              <Button key="cancel" onClick={cancel}>
                {t('common.cancel')}
              </Button>
            ]
      }
    >
      {!asking ? (
        <div className={styles.conflictScanning}>
          <Spin size="small" />
          <span>{t('sftp.uploadScanningHint', { count: request.names.length })}</span>
        </div>
      ) : (
        <div>
          <Alert
            type="warning"
            showIcon
            message={t('sftp.conflictDesc')}
            style={{ marginBottom: 10 }}
          />
          <div className={styles.fastDeleteList}>
            {result.conflicts.slice(0, LIST_LIMIT).map((c) => (
              <div key={c.name}>
                {c.name}
                <span className={styles.conflictMeta}>
                  {c.kind === 'dir' ? t('sftp.conflictIsDir') : formatBytes(c.size)}
                </span>
              </div>
            ))}
            {result.conflicts.length > LIST_LIMIT && (
              <div>{t('sftp.conflictMore', { count: result.conflicts.length - LIST_LIMIT })}</div>
            )}
          </div>
          {/* 三种选择各自的代价都要说清楚，否则"全部重命名"是盲选 */}
          <div className={styles.fastDeleteHint}>{t('sftp.conflictOverwriteHint')}</div>
          <div className={styles.fastDeleteHint}>{t('sftp.conflictSkipHint')}</div>
          <div className={styles.fastDeleteHint}>{t('sftp.conflictRenameHint')}</div>
        </div>
      )}
    </Modal>
  )
}
