import { useEffect } from 'react'
import { App as AntdApp, Button, Modal, Progress, Tag, Typography } from 'antd'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUpdateStore } from '@/stores/useUpdateStore'

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

  useEffect(() => {
    // 没状态时拉一次（main 侧启动那轮检查可能还没跑到，或这个面板是第一次被打开）
    if (!state) void check().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const status = state?.status ?? 'idle'
  const checking = status === 'checking'
  const downloading = status === 'downloading'

  const doInstall = async (force: boolean): Promise<void> => {
    const started = await install(force)
    if (started) dismissConfirm()
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
          <Tag color="blue">{t('update.availableTag', { version: state?.version ?? '' })}</Tag>
        ) : status === 'none' ? (
          <Typography.Text type="secondary">{t('update.upToDate')}</Typography.Text>
        ) : status === 'error' ? (
          <Typography.Text type="danger">{t('update.failed')}</Typography.Text>
        ) : checking ? (
          <Typography.Text type="secondary">{t('update.checking')}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">{t('update.idle')}</Typography.Text>
        )}

        {status !== 'unsupported' && (
          <Button
            size="small"
            loading={checking}
            icon={<RefreshCw size={13} strokeWidth={1.75} />}
            onClick={() => void check().catch((e) => message.error(String(e)))}
          >
            {t('update.check')}
          </Button>
        )}
        {status === 'downloaded' && (
          <Button type="primary" size="small" onClick={() => void doInstall(false)}>
            {t('update.install')}
          </Button>
        )}
      </div>

      {downloading && (
        <Progress
          percent={state?.percent ?? 0}
          size="small"
          status="active"
          style={{ maxWidth: 320 }}
        />
      )}

      {status === 'error' && state?.error && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 4 }}>
          {state.error}
        </Typography.Paragraph>
      )}

      <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 8 }}>
        {t('update.note')}
      </Typography.Paragraph>

      <Modal
        open={confirm !== null}
        title={t('update.confirmTitle')}
        okText={t('update.confirmOk')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true }}
        onOk={() => void doInstall(true)}
        onCancel={dismissConfirm}
      >
        <p>
          {t('update.confirmBody', {
            sessions: confirm?.sessions ?? 0,
            transfers: confirm?.transfers ?? 0,
            forwards: confirm?.forwards ?? 0
          })}
        </p>
        <p>{t('update.confirmTail')}</p>
      </Modal>
    </div>
  )
}
