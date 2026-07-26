import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Dropdown,
  Empty,
  Input,
  Spin,
  Table,
  Tooltip,
  type TableColumnsType
} from 'antd'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Eye,
  EyeOff,
  FolderPlus,
  RefreshCw,
  Upload
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SftpEntry } from '@shared/types'
import { ofs } from '@/ipc/api'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTransferStore } from '@/stores/useTransferStore'
import type { SessionTab } from '@/stores/useSessionStore'
import { formatBytes, formatTimestamp } from '@/utils/format'
import { FileIcon } from './FileIcon'
import { PermissionModal } from './PermissionModal'
import styles from './SftpPane.module.css'

interface Props {
  tab: SessionTab
  active: boolean
}

/** 远端路径工具（renderer 侧只做展示用拼接，真正的规范化在 main） */
function joinRemote(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}
function parentOf(dir: string): string {
  if (dir === '/' || !dir.includes('/')) return '/'
  const trimmed = dir.replace(/\/$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

export function SftpPane({ tab, active }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { message, modal } = AntdApp.useApp()
  const settings = useSettingsStore((s) => s.settings)!
  const patchSettings = useSettingsStore((s) => s.patch)
  const enqueue = useTransferStore((s) => s.enqueue)

  const [cwd, setCwd] = useState<string>('')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [history, setHistory] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 })
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [permTarget, setPermTarget] = useState<SftpEntry | null>(null)
  const [dragOver, setDragOver] = useState(false)
  /** 右键菜单：受控 + 定位到光标（虚拟表格不能覆写 row 组件） */
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: SftpEntry } | null>(
    null
  )
  const initializedRef = useRef(false)

  const showHidden = settings.sftp.showHiddenFiles

  const load = useCallback(
    async (dir: string, pushHistory = true): Promise<void> => {
      if (!tab.sessionId) return
      setLoading(true)
      setError(null)
      try {
        const list = await ofs.invoke('sftp:readdir', { sessionId: tab.sessionId, path: dir })
        setEntries(list)
        setCwd(dir)
        setSelected([])
        if (pushHistory) {
          setHistory((h) => {
            const stack = [...h.stack.slice(0, h.index + 1), dir]
            return { stack, index: stack.length - 1 }
          })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [tab.sessionId]
  )

  // 首次打开：解析 home 目录
  useEffect(() => {
    if (initializedRef.current || !tab.sessionId || tab.state !== 'ready') return
    initializedRef.current = true
    void ofs
      .invoke('sftp:realpath', { sessionId: tab.sessionId, path: '.' })
      .then((home) => load(home))
      .catch(() => load('/'))
  }, [tab.sessionId, tab.state, load])

  // 会话重连后重新拉取当前目录
  useEffect(() => {
    if (tab.state === 'ready' && initializedRef.current && cwd && entries.length === 0 && !loading) {
      void load(cwd, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.shellEpoch])

  const visible = useMemo(() => {
    const list = showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))
    // 目录恒排前
    return [...list].sort((a, b) => {
      const aDir = a.type === 'dir' || (a.type === 'symlink' && a.targetType === 'dir')
      const bDir = b.type === 'dir' || (b.type === 'symlink' && b.targetType === 'dir')
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [entries, showHidden])

  const isDir = (e: SftpEntry): boolean =>
    e.type === 'dir' || (e.type === 'symlink' && e.targetType === 'dir')

  const openEntry = (entry: SftpEntry): void => {
    if (entry.badName) {
      message.warning(t('sftp.badNameWarning'))
      return
    }
    if (isDir(entry)) void load(entry.path)
    else void download([entry])
  }

  const download = async (items: SftpEntry[]): Promise<void> => {
    if (!tab.sessionId) return
    const dir =
      settings.sftp.downloadDir ||
      (await ofs.invoke('app:pickPath', { mode: 'openDirectory', title: t('sftp.pickDownloadDir') }))
    if (!dir) return
    await enqueue(
      items.map((e) => ({
        sessionId: tab.sessionId!,
        kind: 'download' as const,
        remotePath: e.path,
        localPath: `${dir.replace(/[\\/]$/, '')}\\${e.name}`
      }))
    )
    message.success(t('sftp.enqueuedDownload', { count: items.length }))
  }

  const uploadPaths = async (localPaths: string[], targetDir = cwd): Promise<void> => {
    if (!tab.sessionId || localPaths.length === 0) return
    await enqueue(
      localPaths.map((p) => ({
        sessionId: tab.sessionId!,
        kind: 'upload' as const,
        localPath: p,
        remotePath: joinRemote(targetDir, p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'file')
      }))
    )
    message.success(t('sftp.enqueuedUpload', { count: localPaths.length }))
    setTimeout(() => void load(cwd, false), 1500)
  }

  const pickAndUpload = async (): Promise<void> => {
    const path = await ofs.invoke('app:pickPath', { mode: 'openFile', title: t('sftp.pickUpload') })
    if (path) await uploadPaths([path])
  }

  const doMkdir = (): void => {
    let name = ''
    modal.confirm({
      title: t('sftp.newFolder'),
      content: <Input autoFocus onChange={(e) => (name = e.target.value)} />,
      okText: t('common.ok'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        if (!name.trim() || !tab.sessionId) return
        await ofs.invoke('sftp:mkdir', {
          sessionId: tab.sessionId,
          path: joinRemote(cwd, name.trim())
        })
        await load(cwd, false)
      }
    })
  }

  const doRename = async (entry: SftpEntry, newName: string): Promise<void> => {
    setRenamingPath(null)
    if (!tab.sessionId || !newName.trim() || newName === entry.name) return
    try {
      await ofs.invoke('sftp:rename', {
        sessionId: tab.sessionId,
        from: entry.path,
        to: joinRemote(cwd, newName.trim())
      })
      await load(cwd, false)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const doDelete = (items: SftpEntry[]): void => {
    modal.confirm({
      title: t('sftp.deleteConfirm', { count: items.length, name: items[0]?.name ?? '' }),
      content: t('sftp.deleteIrreversible'),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        if (!tab.sessionId) return
        for (const item of items) {
          await ofs.invoke('sftp:delete', {
            sessionId: tab.sessionId,
            path: item.path,
            recursive: isDir(item)
          })
        }
        await load(cwd, false)
      }
    })
  }

  const columns: TableColumnsType<SftpEntry> = [
    {
      title: t('sftp.colName'),
      dataIndex: 'name',
      ellipsis: true,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (_: unknown, entry) => (
        <div className={styles.nameCell}>
          <FileIcon entry={entry} />
          {renamingPath === entry.path ? (
            <Input
              size="small"
              autoFocus
              defaultValue={entry.name}
              onBlur={(e) => void doRename(entry, e.target.value)}
              onPressEnter={(e) => void doRename(entry, (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setRenamingPath(null)
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className={`${styles.nameText} ${entry.badName ? styles.badName : ''}`}>
              {entry.name}
            </span>
          )}
        </div>
      )
    },
    {
      title: t('sftp.colSize'),
      dataIndex: 'size',
      width: 96,
      align: 'right',
      sorter: (a, b) => a.size - b.size,
      render: (size: number, entry) =>
        isDir(entry) ? '-' : <Tooltip title={`${size} B`}>{formatBytes(size)}</Tooltip>
    },
    {
      title: t('sftp.colMode'),
      dataIndex: 'modeStr',
      width: 104,
      render: (modeStr: string, entry) => (
        <a
          style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}
          onClick={(e) => {
            e.stopPropagation()
            setPermTarget(entry)
          }}
        >
          {modeStr}
        </a>
      )
    },
    { title: t('sftp.colOwner'), dataIndex: 'owner', width: 90, ellipsis: true },
    {
      title: t('sftp.colMtime'),
      dataIndex: 'mtime',
      width: 132,
      sorter: (a, b) => a.mtime - b.mtime,
      render: (mtime: number) => formatTimestamp(mtime)
    }
  ]

  const selectedEntries = visible.filter((e) => selected.includes(e.path))

  const contextItems = (entry: SftpEntry): Array<{ key: string; label: string; danger?: boolean }> => [
    { key: 'open', label: isDir(entry) ? t('sftp.open') : t('sftp.download') },
    { key: 'rename', label: t('common.rename') },
    { key: 'perm', label: t('sftp.permissions') },
    { key: 'copyPath', label: t('sftp.copyPath') },
    { key: 'newFolder', label: t('sftp.newFolder') },
    { key: 'refresh', label: t('sftp.refresh') },
    { key: 'delete', label: t('common.delete'), danger: true }
  ]

  const onContextClick = (entry: SftpEntry, key: string): void => {
    const targets = selectedEntries.length > 1 && selected.includes(entry.path) ? selectedEntries : [entry]
    if (key === 'open') openEntry(entry)
    else if (key === 'rename') setRenamingPath(entry.path)
    else if (key === 'perm') setPermTarget(entry)
    else if (key === 'copyPath') void navigator.clipboard.writeText(entry.path)
    else if (key === 'newFolder') doMkdir()
    else if (key === 'refresh') void load(cwd, false)
    else if (key === 'delete') doDelete(targets)
  }

  const crumbs = useMemo(() => {
    const segs = cwd.split('/').filter(Boolean)
    return [{ label: '/', path: '/' }, ...segs.map((s, i) => ({ label: s, path: `/${segs.slice(0, i + 1).join('/')}` }))]
  }, [cwd])

  if (tab.state !== 'ready' && entries.length === 0) {
    return (
      <div className={styles.pane}>
        <div className={styles.emptyWrap}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('sftp.waitingSession')} />
        </div>
      </div>
    )
  }

  return (
    <div
      className={styles.pane}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const paths = [...e.dataTransfer.files]
          .map((f) => {
            try {
              return ofs.getPathForFile(f)
            } catch {
              return ''
            }
          })
          .filter(Boolean)
        if (paths.length === 0) {
          message.warning(t('sftp.dropUnsupported'))
          return
        }
        void uploadPaths(paths)
      }}
    >
      <div className={styles.toolbar}>
        <Tooltip title={t('sftp.back')}>
          <Button
            size="small"
            type="text"
            disabled={history.index <= 0}
            icon={<ArrowLeft size={14} strokeWidth={1.75} />}
            onClick={() => {
              const idx = history.index - 1
              setHistory((h) => ({ ...h, index: idx }))
              void load(history.stack[idx], false)
            }}
          />
        </Tooltip>
        <Tooltip title={t('sftp.forward')}>
          <Button
            size="small"
            type="text"
            disabled={history.index >= history.stack.length - 1}
            icon={<ArrowRight size={14} strokeWidth={1.75} />}
            onClick={() => {
              const idx = history.index + 1
              setHistory((h) => ({ ...h, index: idx }))
              void load(history.stack[idx], false)
            }}
          />
        </Tooltip>
        <Tooltip title={t('sftp.up')}>
          <Button
            size="small"
            type="text"
            icon={<ArrowUp size={14} strokeWidth={1.75} />}
            onClick={() => void load(parentOf(cwd))}
          />
        </Tooltip>
        <Tooltip title={t('sftp.refresh')}>
          <Button
            size="small"
            type="text"
            icon={<RefreshCw size={14} strokeWidth={1.75} />}
            onClick={() => void load(cwd, false)}
          />
        </Tooltip>

        {editingPath === null ? (
          <div className={styles.breadcrumbBar} onClick={() => setEditingPath(cwd)}>
            {crumbs.map((c, i) => (
              <span key={c.path}>
                {/* 第 0 段的 label 本身就是 "/"，再补一个分隔符会渲染成 "//root" */}
                {i > 1 && <span className={styles.crumbSep}>/</span>}
                <span
                  className={styles.crumb}
                  onClick={(e) => {
                    e.stopPropagation()
                    void load(c.path)
                  }}
                >
                  {c.label}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <Input
            className={styles.pathInput}
            size="small"
            autoFocus
            defaultValue={cwd}
            onPressEnter={(e) => {
              const value = (e.target as HTMLInputElement).value.trim()
              setEditingPath(null)
              if (value) void load(value)
            }}
            onBlur={() => setEditingPath(null)}
          />
        )}

        <Tooltip title={t('sftp.newFolder')}>
          <Button size="small" type="text" icon={<FolderPlus size={14} strokeWidth={1.75} />} onClick={doMkdir} />
        </Tooltip>
        <Tooltip title={t('sftp.upload')}>
          <Button
            size="small"
            type="text"
            icon={<Upload size={14} strokeWidth={1.75} />}
            onClick={() => void pickAndUpload()}
          />
        </Tooltip>
        <Tooltip title={showHidden ? t('sftp.hideHidden') : t('sftp.showHidden')}>
          <Button
            size="small"
            type="text"
            icon={
              showHidden ? <Eye size={14} strokeWidth={1.75} /> : <EyeOff size={14} strokeWidth={1.75} />
            }
            onClick={() => patchSettings({ sftp: { ...settings.sftp, showHiddenFiles: !showHidden } })}
          />
        </Tooltip>
      </div>

      <div className={styles.table}>
        {error ? (
          <div className={styles.emptyWrap}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span>
                  {error}
                  <br />
                  <a onClick={() => void load(cwd, false)}>{t('common.retry')}</a>
                </span>
              }
            />
          </div>
        ) : loading && entries.length === 0 ? (
          <div className={styles.emptyWrap}>
            <Spin />
          </div>
        ) : (
          <Table<SftpEntry>
            size="small"
            virtual
            scroll={{ y: 220, x: 620 }}
            pagination={false}
            rowKey="path"
            columns={columns}
            dataSource={visible}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as string[]),
              columnWidth: 32
            }}
            onRow={(entry) => ({
              onDoubleClick: () => openEntry(entry),
              onContextMenu: (e) => {
                // 不覆写 row 组件：virtual 模式下 antd 的单元格是 div，
                // 强行套在 <tr> 上会产生非法 DOM 嵌套。改为在光标处开受控菜单。
                e.preventDefault()
                if (!selected.includes(entry.path)) setSelected([entry.path])
                setContextMenu({ x: e.clientX, y: e.clientY, entry })
              }
            })}
          />
        )}
      </div>

      {contextMenu && (
        <Dropdown
          open
          trigger={[]}
          menu={{
            items: contextItems(contextMenu.entry),
            onClick: ({ key }) => {
              const entry = contextMenu.entry
              setContextMenu(null)
              onContextClick(entry, key)
            }
          }}
          onOpenChange={(open) => {
            if (!open) setContextMenu(null)
          }}
        >
          {/* 1×1 锚点：把菜单定位到光标位置 */}
          <span
            style={{
              position: 'fixed',
              left: contextMenu.x,
              top: contextMenu.y,
              width: 1,
              height: 1,
              pointerEvents: 'none'
            }}
          />
        </Dropdown>
      )}

      {dragOver && <div className={styles.dropMask}>{t('sftp.dropToUpload', { dir: cwd })}</div>}

      {permTarget && (
        <PermissionModal
          open
          path={permTarget.path}
          mode={permTarget.mode}
          onCancel={() => setPermTarget(null)}
          onOk={async (mode) => {
            const target = permTarget
            setPermTarget(null)
            if (!tab.sessionId || !target) return
            try {
              await ofs.invoke('sftp:chmod', { sessionId: tab.sessionId, path: target.path, mode })
              await load(cwd, false)
            } catch (err) {
              message.error(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}

      {!active && null}
    </div>
  )
}
