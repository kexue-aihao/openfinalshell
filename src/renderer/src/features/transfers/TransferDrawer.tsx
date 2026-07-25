import { Drawer } from 'antd'
import { useTranslation } from 'react-i18next'
import { useTransferStore } from '@/stores/useTransferStore'
import { TransferList } from './TransferList'

/** 底部弹出的传输队列抽屉（状态栏/活动栏均可打开） */
export function TransferDrawer(): React.JSX.Element {
  const { t } = useTranslation()
  const open = useTransferStore((s) => s.drawerOpen)
  const setOpen = useTransferStore((s) => s.setDrawerOpen)

  return (
    <Drawer
      title={t('sidebar.transfers')}
      placement="bottom"
      height={300}
      open={open}
      onClose={() => setOpen(false)}
      styles={{ body: { padding: 12 } }}
    >
      <TransferList />
    </Drawer>
  )
}
