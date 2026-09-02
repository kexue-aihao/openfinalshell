import { useEffect, useMemo, useRef, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Dropdown,
  Empty,
  Input,
  Tooltip,
  Tree,
  type TreeDataNode
} from 'antd'
import { FolderOpen, FolderPlus, Plus, Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ConnectionGroup, ConnectionProfile } from '@shared/types'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUiStore } from '@/stores/useUiStore'
import { RegionMarker, effectiveMarker } from './RegionMarker'
import { maskHost } from './maskHost'
import styles from './ConnectionTreePanel.module.css'

const GROUP_PREFIX = 'g:'
const PROFILE_PREFIX = 'p:'

export function ConnectionTreePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { modal, message } = AntdApp.useApp()
  const { profiles, groups, loaded, searchText, load, remove, duplicate, saveGroup, removeGroup, setSearchText } =
    useConnectionStore()
  const launchProfile = useSessionStore((s) => s.launchProfile)
  const setEditingProfile = useUiStore((s) => s.setEditingProfile)
  // 连接列表默认对 host 打码（截图脱敏）；用户可在设置里关掉。完整 host 仍用于连接/复制/搜索
  const maskInList = useSettingsStore((s) => s.settings?.connection.maskHostInList ?? true)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // 连接树默认展开：启动时把所有分组展开，之后新建的分组也自动展开，
  // 而用户手动折叠过的分组不再被强行展开（seenGroups 记住"已经替它做过一次展开决定"）
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const seenGroups = useRef<Set<string>>(new Set())
  useEffect(() => {
    const fresh = groups
      .map((g) => `${GROUP_PREFIX}${g.id}`)
      .filter((k) => !seenGroups.current.has(k))
    if (fresh.length === 0) return
    fresh.forEach((k) => seenGroups.current.add(k))
    setExpandedKeys((prev) => [...new Set([...prev, ...fresh])])
  }, [groups])

  const connect = (profile: ConnectionProfile): void => {
    launchProfile(profile)
      .then((kind) => {
        if (kind === 'rdp') message.success(t('conn.rdpLaunched'))
      })
      .catch((err) => message.error(err instanceof Error ? err.message : String(err)))
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
        <Tooltip
          // 有备注才挂 Tooltip：大树里每个节点都包一层是白付出的成本。
          // 悬停展示 备注 + 完整 user@host（行内那份会被宽度截断）
          title={
            p.note ? (
              <span style={{ whiteSpace: 'pre-wrap' }}>
                {p.note}
                <br />
                <span className="ofs-dim">
                  {p.username}@{p.host}
                </span>
              </span>
            ) : null
          }
          placement="right"
          mouseEnterDelay={0.4}
        >
          <span className={styles.node} onDoubleClick={() => connect(p)}>
            {(() => {
              // 位置标记优先：显式手选 > 私网自动局域网 > 回退颜色点
              const marker = effectiveMarker(p.flag, p.host)
              if (marker) return <RegionMarker code={marker} />
              if (p.color) return <span className={styles.colorDot} style={{ background: p.color }} />
              return null
            })()}
            <Server size={13} strokeWidth={1.75} style={{ flex: 'none' }} />
            <span className={styles.nodeText}>
              <span className={styles.nodeName}>{p.name}</span>
              {/* 有备注时副标题显示备注，否则退回 user@host；完整信息仍在 Tooltip 里 */}
              <span className={styles.nodeHost}>
                {p.note || `${p.username}@${maskInList ? maskHost(p.host) : p.host}`}
              </span>
            </span>
          </span>
        </Tooltip>
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
  }, [profiles, groups, searchText, t, maskInList])

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
            // 搜索态是平铺的 profile 列表（无分组），expandedKeys 在那种情况下无意义
            expandedKeys={searchText.trim() ? undefined : expandedKeys}
            onExpand={(keys) => setExpandedKeys(keys)}
          />
        )}
      </div>
    </div>
  )
}
