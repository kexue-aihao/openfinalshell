import { useEffect, useMemo } from 'react'
import { App as AntdApp, Button, Dropdown, Empty, Input, Tree, type TreeDataNode } from 'antd'
import { FolderOpen, FolderPlus, Plus, Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ConnectionGroup, ConnectionProfile } from '@shared/types'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUiStore } from '@/stores/useUiStore'
import styles from './ConnectionTreePanel.module.css'

const GROUP_PREFIX = 'g:'
const PROFILE_PREFIX = 'p:'

export function ConnectionTreePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { modal, message } = AntdApp.useApp()
  const { profiles, groups, loaded, searchText, load, remove, duplicate, saveGroup, removeGroup, setSearchText } =
    useConnectionStore()
  const openForProfile = useSessionStore((s) => s.openForProfile)
  const setEditingProfile = useUiStore((s) => s.setEditingProfile)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const connect = (profile: ConnectionProfile): void => {
    void openForProfile(profile)
  }

  const promptNewGroup = (parentId: string | null): void => {
    let name = ''
    modal.confirm({
      title: t('sidebar.newGroup'),
      content: (
        <Input
          autoFocus
          placeholder={t('conn.groupNamePlaceholder')}
          onChange={(e) => (name = e.target.value)}
        />
      ),
      okText: t('common.ok'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        if (!name.trim()) return
        await saveGroup({ id: crypto.randomUUID(), name: name.trim(), parentId, order: Date.now() })
      }
    })
  }

  const promptRenameGroup = (group: ConnectionGroup): void => {
    let name = group.name
    modal.confirm({
      title: t('common.rename'),
      content: (
        <Input autoFocus defaultValue={group.name} onChange={(e) => (name = e.target.value)} />
      ),
      okText: t('common.ok'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        if (!name.trim()) return
        await saveGroup({ ...group, name: name.trim() })
      }
    })
  }

  const confirmDeleteProfile = (profile: ConnectionProfile): void => {
    modal.confirm({
      title: t('conn.deleteConfirm', { name: profile.name }),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        await remove(profile.id)
        message.success(t('conn.deleted'))
      }
    })
  }

  const profileNode = (p: ConnectionProfile): TreeDataNode => ({
    key: `${PROFILE_PREFIX}${p.id}`,
    isLeaf: true,
    title: (
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items: [
            { key: 'connect', label: t('conn.connect') },
            { key: 'edit', label: t('common.edit') },
            { key: 'duplicate', label: t('conn.duplicate') },
            { key: 'copyCmd', label: t('conn.copySshCommand') },
            { type: 'divider' },
            { key: 'delete', label: t('common.delete'), danger: true }
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation()
            if (key === 'connect') connect(p)
            else if (key === 'edit') setEditingProfile(p.id)
            else if (key === 'duplicate') void duplicate(p.id)
            else if (key === 'delete') confirmDeleteProfile(p)
            else if (key === 'copyCmd') {
              void navigator.clipboard.writeText(`ssh ${p.username}@${p.host} -p ${p.port}`)
              message.success(t('conn.copied'))
            }
          }
        }}
      >
        <span className={styles.node} onDoubleClick={() => connect(p)}>
          {p.color && <span className={styles.colorDot} style={{ background: p.color }} />}
          <Server size={13} strokeWidth={1.75} style={{ flex: 'none' }} />
          <span className={styles.nodeName}>{p.name}</span>
          <span className={styles.nodeHost}>
            {p.username}@{p.host}
          </span>
        </span>
      </Dropdown>
    )
  })

  const groupNode = (g: ConnectionGroup, children: TreeDataNode[]): TreeDataNode => ({
    key: `${GROUP_PREFIX}${g.id}`,
    children,
    title: (
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items: [
            { key: 'newConn', label: t('sidebar.newConnection') },
            { key: 'newGroup', label: t('sidebar.newGroup') },
            { key: 'rename', label: t('common.rename') },
            { type: 'divider' },
            { key: 'delete', label: t('common.delete'), danger: true }
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation()
            if (key === 'newConn') setEditingProfile('new')
            else if (key === 'newGroup') promptNewGroup(g.id)
            else if (key === 'rename') promptRenameGroup(g)
            else if (key === 'delete') void removeGroup(g.id)
          }
        }}
      >
        <span className={styles.node}>
          <FolderOpen size={13} strokeWidth={1.75} style={{ flex: 'none' }} />
          <span className={styles.nodeName}>{g.name}</span>
        </span>
      </Dropdown>
    )
  })

  const treeData = useMemo((): TreeDataNode[] => {
    const q = searchText.trim().toLowerCase()
    if (q) {
      return profiles
        .filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.host.toLowerCase().includes(q) ||
            p.username.toLowerCase().includes(q)
        )
        .map(profileNode)
    }
    const buildGroup = (parentId: string | null): TreeDataNode[] => {
      const childGroups = groups
        .filter((g) => g.parentId === parentId)
        .sort((a, b) => a.order - b.order)
        .map((g) => groupNode(g, buildGroup(g.id)))
      const childProfiles = profiles
        .filter((p) => (p.groupId ?? null) === parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(profileNode)
      return [...childGroups, ...childProfiles]
    }
    return buildGroup(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, groups, searchText, t])

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <Input
          size="small"
          allowClear
          placeholder={t('sidebar.searchPlaceholder')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <Button
          size="small"
          type="text"
          icon={<Plus size={14} strokeWidth={1.75} />}
          title={t('sidebar.newConnection')}
          onClick={() => setEditingProfile('new')}
        />
        <Button
          size="small"
          type="text"
          icon={<FolderPlus size={14} strokeWidth={1.75} />}
          title={t('sidebar.newGroup')}
          onClick={() => promptNewGroup(null)}
        />
      </div>
      <div className={styles.tree}>
        {treeData.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('sidebar.emptyConnections')}
            style={{ marginTop: 48 }}
          />
        ) : (
          <Tree.DirectoryTree
            treeData={treeData}
            blockNode
            showIcon={false}
            expandAction="click"
            selectable={false}
          />
        )}
      </div>
    </div>
  )
}
