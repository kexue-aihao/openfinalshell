import { IconButton, EmptyState } from '@/components/ui'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  App as AntdApp,
  Dropdown,
  Input,
  Tooltip,
  Tree,
  type MenuProps,
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

type ContextMenuTarget =
  | { kind: 'profile'; profile: ConnectionProfile }
  | { kind: 'group'; group: ConnectionGroup }

interface ContextMenuState {
  open: boolean
  x: number
  y: number
  /** 每次打开递增，作为 Dropdown 的 key，强制新弹层按新坐标重新对齐。 */
  token: number
  target: ContextMenuTarget | null
}

const CLOSED_CONTEXT_MENU: ContextMenuState = { open: false, x: 0, y: 0, token: 0, target: null }

export function ConnectionTreePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { modal, message } = AntdApp.useApp()
  const { profiles, groups, loaded, searchText, load, remove, duplicate, saveGroup, removeGroup, setSearchText } =
    useConnectionStore()
  const launchProfile = useSessionStore((s) => s.launchProfile)
  const setEditingProfile = useUiStore((s) => s.setEditingProfile)
  // 连接列表默认对 host 打码（截图脱敏）；用户可在设置里关掉。完整 host 仍用于连接/复制/搜索
  const maskInList = useSettingsStore((s) => s.settings?.connection.maskHostInList ?? true)

  // 整棵树只有一个右键弹层。此前每个节点各挂一个非受控 Dropdown：慢渲染时
  // 第二次右键可能赶在第一个弹层挂载、注册关闭监听之前，于是多个菜单叠在一起，
  // 点击会命中错误的/正在关闭的弹层。单一受控状态从结构上消除这个竞态。
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(CLOSED_CONTEXT_MENU)

  const closeContextMenu = useCallback((): void => {
    setContextMenu((current) => (current.open ? { ...current, open: false } : current))
  }, [])

  const openContextMenu = useCallback((event: ReactMouseEvent, target: ContextMenuTarget): void => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu((current) => ({
      open: true,
      x: event.clientX,
      y: event.clientY,
      token: current.token + 1,
      target
    }))
  }, [])

  useEffect(() => {
    if (!contextMenu.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeContextMenu()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', closeContextMenu)
    window.addEventListener('resize', closeContextMenu)
    // 捕获滚动，覆盖连接树自身和任何可滚动祖先，避免菜单跟着列表滚走。
    window.addEventListener('scroll', closeContextMenu, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', closeContextMenu)
      window.removeEventListener('resize', closeContextMenu)
      window.removeEventListener('scroll', closeContextMenu, true)
    }
  }, [contextMenu.open, closeContextMenu])

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
        <span
          className={styles.node}
          onDoubleClick={() => connect(p)}
          onContextMenu={(event) => openContextMenu(event, { kind: 'profile', profile: p })}
        >
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
    )
  })

  const groupNode = (g: ConnectionGroup, children: TreeDataNode[]): TreeDataNode => ({
    key: `${GROUP_PREFIX}${g.id}`,
    children,
    title: (
      <span
        className={styles.node}
        onContextMenu={(event) => openContextMenu(event, { kind: 'group', group: g })}
      >
        <FolderOpen size={13} strokeWidth={1.75} style={{ flex: 'none' }} />
        <span className={styles.nodeName}>{g.name}</span>
      </span>
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
  }, [profiles, groups, searchText, t, maskInList, openContextMenu])

  const contextMenuItems = useMemo<MenuProps['items']>(() => {
    const target = contextMenu.target
    if (!target) return []
    if (target.kind === 'profile') {
      return [
        { key: 'connect', label: t('conn.connect') },
        { key: 'edit', label: t('common.edit') },
        { key: 'duplicate', label: t('conn.duplicate') },
        { key: 'copyCmd', label: t('conn.copySshCommand') },
        { type: 'divider' },
        { key: 'delete', label: t('common.delete'), danger: true }
      ]
    }
    return [
      { key: 'newConn', label: t('sidebar.newConnection') },
      { key: 'newGroup', label: t('sidebar.newGroup') },
      { key: 'rename', label: t('common.rename') },
      { type: 'divider' },
      { key: 'delete', label: t('common.delete'), danger: true }
    ]
  }, [contextMenu.target, t])

  const handleContextMenuClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation()
    const target = contextMenu.target
    closeContextMenu()
    if (!target) return
    if (target.kind === 'profile') {
      const p = target.profile
      if (key === 'connect') connect(p)
      else if (key === 'edit') setEditingProfile(p.id)
      else if (key === 'duplicate') void duplicate(p.id)
      else if (key === 'delete') confirmDeleteProfile(p)
      else if (key === 'copyCmd') {
        void navigator.clipboard.writeText(`ssh ${p.username}@${p.host} -p ${p.port}`)
        message.success(t('conn.copied'))
      }
      return
    }
    const group = target.group
    if (key === 'newConn') setEditingProfile('new')
    else if (key === 'newGroup') promptNewGroup(group.id)
    else if (key === 'rename') promptRenameGroup(group)
    else if (key === 'delete') void removeGroup(group.id)
  }

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
        <IconButton label={t('sidebar.newConnection')}
              size="small"
          icon={<Plus size={14} strokeWidth={1.75} />}
          title={t('sidebar.newConnection')}
          onClick={() => setEditingProfile('new')}
        />
        <IconButton label={t('sidebar.newGroup')}
              size="small"
          icon={<FolderPlus size={14} strokeWidth={1.75} />}
          title={t('sidebar.newGroup')}
          onClick={() => promptNewGroup(null)}
        />
      </div>
      <div className={styles.tree}>
        {treeData.length === 0 ? (
          <EmptyState title={t('sidebar.emptyConnections')} />
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
      <Dropdown
        key={contextMenu.token}
        open={contextMenu.open}
        onOpenChange={(open) => {
          if (!open) closeContextMenu()
        }}
        trigger={['contextMenu']}
        placement="bottomLeft"
        menu={{ items: contextMenuItems, onClick: handleContextMenuClick }}
      >
        <span
          aria-hidden="true"
          data-context-menu-anchor="true"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            width: 0,
            height: 0,
            pointerEvents: 'none'
          }}
        />
      </Dropdown>
    </div>
  )
}
