import { useState } from 'react'
import { App as AntdApp, Alert, Button, Modal, Radio, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type { FinalShellConflictPolicy, FinalShellImportResult, FinalShellScan } from '@shared/types'
import { ofs } from '@/ipc/api'
import { useConnectionStore } from '@/stores/useConnectionStore'
import styles from './SettingsModal.module.css'

/**
 * 从 FinalShell 导入。两步：选目录扫描 → 确认后写入。
 *
 * 界面上必须**把带不过来的东西写在用户点确认之前**（密码、密钥、代理、转发）——
 * 导完再说等于让他先以为搬完了。那几行文案由 main 侧的 scan 给出，不在这里编：
 * 它们是"扫描时真的看见了 N 条"，不是泛泛的免责声明。
 */
export function FinalShellImportPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const reloadConnections = useConnectionStore((s) => s.load)
  const [scan, setScan] = useState<FinalShellScan | null>(null)
  const [conflict, setConflict] = useState<FinalShellConflictPolicy>('skip')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FinalShellImportResult | null>(null)

  const pick = async (): Promise<void> => {
    setBusy(true)
    try {
      // 不传 dir：目录由 main 侧的系统对话框决定，渲染进程没有机会指定路径
      const r = await ofs.invoke('app:finalshellScan', {})
      if (r) setScan(r)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const doImport = async (): Promise<void> => {
    if (!scan) return
    setBusy(true)
    try {
      const r = await ofs.invoke('app:finalshellImport', { token: scan.token, conflict })
      setScan(null)
      setResult(r)
      // 连接树立刻刷新：不刷的话用户回到主界面看不到导进来的东西，会再导一遍
      await reloadConnections()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        {t('settings.fsImportTitle')}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t('settings.fsImportDesc')}
      </Typography.Paragraph>
      <Button loading={busy && !scan} onClick={() => void pick()}>
        {t('settings.fsImportButton')}
      </Button>

      <Modal
        open={scan !== null}
        title={t('settings.fsImportModalTitle')}
        okText={t('settings.importConfirm')}
        cancelText={t('common.cancel')}
        confirmLoading={busy}
        onCancel={() => setScan(null)}
        onOk={() => void doImport()}
        width={620}
      >
        {scan && (
          <>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              {scan.dir}
            </Typography.Paragraph>
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              {t('settings.fsImportCounts', {
                profiles: scan.counts.profiles,
                groups: scan.counts.groups
              })}
            </Typography.Paragraph>

            {scan.samples.length > 0 && (
              <div className={styles.fsSamples}>
                {scan.samples.map((s) => (
                  <div key={`${s.host}:${s.port}:${s.username}`}>
                    {s.name} — {s.username}@{s.host}:{s.port}
                  </div>
                ))}
                {scan.counts.profiles > scan.samples.length && (
                  <div>{t('settings.fsImportMore', { count: scan.counts.profiles - scan.samples.length })}</div>
                )}
              </div>
            )}

            {/* 带不过来的东西：一条一条列在确认按钮之前 */}
            {scan.notes.map((note) => (
              <Alert key={note} type="warning" showIcon style={{ marginTop: 8 }} message={note} />
            ))}
            {(scan.counts.invalid > 0 || scan.counts.notSsh > 0) && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
                {t('settings.fsImportSkipped', {
                  invalid: scan.counts.invalid,
                  notSsh: scan.counts.notSsh
                })}
              </Typography.Paragraph>
            )}

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>{t('settings.fsImportConflict')}</div>
              <Radio.Group value={conflict} onChange={(e) => setConflict(e.target.value)}>
                <Radio value="skip">{t('settings.fsImportConflictSkip')}</Radio>
                <Radio value="duplicate">{t('settings.fsImportConflictDuplicate')}</Radio>
              </Radio.Group>
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={result !== null}
        title={t('settings.importResultTitle')}
        footer={null}
        onCancel={() => setResult(null)}
      >
        {result && (
          <>
            <Typography.Paragraph>
              {t('settings.fsImportResult', {
                profiles: result.profiles,
                groups: result.groups,
                skipped: result.skipped
              })}
            </Typography.Paragraph>
            {result.notes.map((note) => (
              <Alert key={note} type="info" showIcon style={{ marginBottom: 8 }} message={note} />
            ))}
          </>
        )}
      </Modal>
    </>
  )
}
