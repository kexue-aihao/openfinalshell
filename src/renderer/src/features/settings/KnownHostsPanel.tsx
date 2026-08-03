import { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Table, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type { TrustedHostkey } from '@shared/types'
import { ofs } from '@/ipc/api'
import { formatTimestamp } from '@/utils/format'

/**
 * 已信任主机指纹管理。补上 TOFU 的另一半：信任是一次点击，撤销此前只能手改数据库 ——
 * 误点信任、或服务器合法重装换了密钥之后，用户需要一个能看见并撤回决定的地方。
 * 撤销不是删除历史：下次连接那台主机会重新走首次确认弹窗。
 */
export function KnownHostsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { message, modal } = AntdApp.useApp()
  const [rows, setRows] = useState<TrustedHostkey[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    try {
      setRows(await ofs.invoke('conn:knownHosts'))
    } catch (err) {
      message.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  const revoke = (row: TrustedHostkey): void => {
    modal.confirm({
      title: t('settings.knownHostsRevokeTitle', { host: `${row.host}:${row.port}` }),
      content: t('settings.knownHostsRevokeDesc'),
      okText: t('settings.knownHostsRevoke'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        await ofs.invoke('conn:knownHostsDelete', row.key)
        void load()
      }
    })
  }

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        {t('settings.knownHostsTitle')}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t('settings.knownHostsDesc')}
      </Typography.Paragraph>
      {!loading && rows.length === 0 ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t('settings.knownHostsEmpty')}
        </Typography.Paragraph>
      ) : (
        <Table<TrustedHostkey>
          size="small"
          rowKey="key"
          loading={loading}
          dataSource={rows}
          pagination={false}
          columns={[
            {
              title: t('settings.knownHostsHost'),
              key: 'host',
              width: 180,
              ellipsis: true,
              render: (_, r) => `${r.host}:${r.port}`
            },
            { title: t('settings.knownHostsAlgo'), dataIndex: 'keyType', width: 130, ellipsis: true },
            {
              title: t('settings.knownHostsFp'),
              dataIndex: 'fingerprintSha256',
              ellipsis: true,
              render: (fp: string) => (
                <Typography.Text style={{ fontSize: 12 }} code copyable={{ text: fp }}>
                  {fp}
                </Typography.Text>
              )
            },
            {
              title: t('settings.knownHostsAddedAt'),
              dataIndex: 'addedAt',
              width: 150,
              render: (ts: number) => formatTimestamp(ts)
            },
            {
              key: 'actions',
              width: 70,
              render: (_, r) => (
                <Button size="small" type="text" danger onClick={() => revoke(r)}>
                  {t('settings.knownHostsRevoke')}
                </Button>
              )
            }
          ]}
        />
      )}
    </>
  )
}
