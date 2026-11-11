import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Modal, Progress, Spin, Tag, Typography } from 'antd'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUpdateStore } from '@/stores/useUpdateStore'
import { formatBytes } from '@/utils/format'

const RELEASES_URL = 'https://github.com/kexue-aihao/openfinalshell/releases'

/**
 * 设置 → 关于里的更新那一段。
 *
 * **「重启并安装」是唯一会真的装的入口**，而且点下去之前若有活动会话/传输/转发，
 * 先弹一个把数字说清楚的确认框 —— 这个软件装更新必然要退出应用，
 * 而退出就断掉所有终端会话。清单由 main 侧算（它才是那些东西的持有者）。
 */
export function UpdatePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const state = useUpdateStore((s) => s.state)
  const confirm = useUpdateStore((s) => s.confirm)
  const check = useUpdateStore((s) => s.check)
  const install = useUpdateStore((s) => s.install)
  const dismissConfirm = useUpdateStore((s) => s.dismissConfirm)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    // 没状态时拉一次（main 侧启动那轮检查可能还没跑到，或这个面板是第一次被打开）
    if (!state) void check().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const status = state?.status ?? 'idle'
  const manual = state?.capability === 'manual'
  const checking = status === 'checking'
  const downloading = status === 'downloading'
  const preparingInstall = status === 'installing'
  const percent = Math.max(0, Math.min(100, Math.round(state?.percent ?? 0)))
  const verifyingDownload = downloading && percent >= 100

  const doInstall = async (force: boolean): Promise<void> => {
    setInstalling(true)
    try {
      const started = await install(force)
      if (started) dismissConfirm()
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div>
      <div className="ofs-update-row">
        {status === 'unsupported' ? (
          // 免安装版：resources 里也有 app-update.yml，但装 NSIS 包等于把它变成安装版
          <Typography.Text type="secondary">{t('update.portable')}</Typography.Text>
        ) : status === 'downloaded' ? (
          <Tag color="green">{t('update.readyTag', { version: state?.version ?? '' })}</Tag>
        ) : status === 'available' ? (
          <Tag color="blue">
            {manual
              ? t('update.manualAvailableTag', { version: state?.version ?? '' })
              : t('update.availableTag', { version: state?.version ?? '' })}
          </Tag>
        ) : status === 'none' ? (
          <Typography.Text type="secondary">{t('update.upToDate')}</Typography.Text>
        ) : status === 'error' ? (
          <Typography.Text type="danger">{t('update.failed')}</Typography.Text>
        ) : checking ? (
          <span className="ofs-update-activity" role="status" aria-live="polite">
            <Spin size="small" />
            <Typography.Text type="secondary">{t('update.checking')}</Typography.Text>
          </span>
        ) : preparingInstall ? (
          <span className="ofs-update-activity" role="status" aria-live="polite">
            <Spin size="small" />
            <Typography.Text type="secondary">{t('update.preparingInstall')}</Typography.Text>
          </span>
        ) : downloading ? (
          null
        ) : (
          <Typography.Text type="secondary">{t('update.idle')}</Typography.Text>
        )}

        {status !== 'unsupported' && (
          <Button
            size="small"
            disabled={checking || downloading || preparingInstall || installing}
            icon={<RefreshCw size={13} strokeWidth={1.75} />}
            onClick={() => void check().catch((e) => message.error(String(e)))}
          >
            {t('update.check')}
          </Button>
        )}
        {status === 'available' && manual && (
          <Button
            type="primary"
            size="small"
            onClick={() =>
              void window.ofs.invoke('app:openExternal', RELEASES_URL)
            }
          >
            {t('update.openReleases')}
          </Button>
        )}
        {status === 'downloaded' && state?.capability === 'install' && (
          <Button type="primary" size="small" disabled={installing} onClick={() => void doInstall(false)}>
            {t('update.install')}
          </Button>
        )}
      </div>

      {installing && (
        <div className="ofs-update-activity" role="status" aria-live="polite">
          <Spin size="small" />
          <Typography.Text type="secondary">{t('update.preparingInstall')}</Typography.Text>
        </div>
      )}

      {downloading && (
        <div className="ofs-update-progress" role="status" aria-live="polite">
          <div className="ofs-update-progress-meta">
            <Typography.Text type="secondary">
              {verifyingDownload
                ? t('update.verifying')
                : t('update.downloading', { version: state?.version ?? '', percent })}
            </Typography.Text>
            {state?.total && state.total > 0 && (
              <Typography.Text type="secondary">
                {t('update.bytesProgress', {
                  transferred: formatBytes(state.transferred ?? 0),
                  total: formatBytes(state.total)
                })}
              </Typography.Text>
            )}
          </div>
          <Progress percent={percent} size="small" status="active" showInfo={false} />
        </div>
      )}

      {status === 'error' && state?.error && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 4 }}>
          {state.error}
        </Typography.Paragraph>
      )}

      <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 8 }}>
        {manual ? t('update.manualNote') : t('update.note')}
      </Typography.Paragraph>

      <Modal
        open={confirm !== null}
        title={t('update.confirmTitle')}
        okText={t('update.confirmOk')}
        cancelText={t('common.cancel')}
        confirmLoading={installing}
        closable={!installing}
        maskClosable={!installing}
        okButtonProps={{ danger: true }}
        onOk={() => void doInstall(true)}
        onCancel={() => { if (!installing) dismissConfirm() }}
      >
        <p>
          {t('update.confirmBody', {
            sessions: confirm?.sessions ?? 0,
            transfers: confirm?.transfers ?? 0,
            forwards: confirm?.forwards ?? 0
          })}
        </p>
        <p>{t('update.confirmTail')}</p>
        {installing && (
          <div className="ofs-update-activity" role="status" aria-live="polite">
            <Spin size="small" />
            <Typography.Text type="secondary">{t('update.preparingInstall')}</Typography.Text>
          </div>
        )}
      </Modal>
    </div>
  )
}
