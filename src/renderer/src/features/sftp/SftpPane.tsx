import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Dropdown,
  Empty,
  Input,
  Spin,
  Table,
  Tooltip,
  type MenuProps,
  type TableColumnsType
} from 'antd'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  FolderPlus,
  RefreshCw,
  Upload
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionId, SftpEntry } from '@shared/types'
import { ofs } from '@/ipc/api'
import { useEditorStore } from '@/stores/useEditorStore'
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

const TRANSFER_FINISHED = new Set(['done', 'error', 'canceled'])

/** 远端命令的 stderr 只给人看前几行：一次 rm -rf 失败可能刷出上千行 Permission denied */
function firstLines(text: string, n: number): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines.length <= n ? lines.join('\n') : `${lines.slice(0, n).join('\n')}\n…`
}
/** 兜底：任务卡住时别把订阅永远挂着，到点无条件刷一次 */
const SETTLE_WATCH_TIMEOUT_MS = 120_000

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
  /** 拖到某个目录行上时的落点（null = 落到当前目录） */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /**
   * 右键菜单：受控 + 定位到光标（虚拟表格不能覆写 row 组件）。
   * entry 为 null = 在空白处右键 —— 菜单还是同一份，只是与选中项相关的条目变灰。
   */
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    entry: SftpEntry | null
  } | null>(null)
  const initializedRef = useRef(false)
  /**
   * dragenter/dragleave 计数。只用 dragleave 关遮罩的话，鼠标扫过任何子元素
   * （行、单元格）都会冒泡出一次 leave，遮罩就跟着闪。
   */
  const dragDepthRef = useRef(0)
  /** 待清理的传输订阅（组件卸载时只退订，不刷新） */
  const settleWatchersRef = useRef(new Set<() => void>())
  /** 刷新时要用最新的 cwd，不能用入队那一刻闭包里的旧值 */
  const cwdRef = useRef('')
  cwdRef.current = cwd
  useEffect(
    () => () => {
      for (const off of settleWatchersRef.current) off()
      settleWatchersRef.current.clear()
    },
    []
  )

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

  /**
   * 「打开」：目录一律进去，文件按调用方给的意图分岔 ——
   * 右键菜单的「打开」固定是编辑（下载在菜单里另有一条），双击则听 doubleClickAction。
   *
   * 'edit' 现在落到**内置编辑器**。上一版它是"下载到本机临时目录 + 起一个外部 exe +
   * 挂文件监视"，那条路整条删掉了 —— 用户的意图没变，兑现方式换成了更安全的那个。
   */
  const openEntry = (entry: SftpEntry, fileAction: 'edit' | 'download'): void => {
    if (entry.badName) {
      message.warning(t('sftp.badNameWarning'))
      return
    }
    if (isDir(entry)) void load(entry.path)
    else if (fileAction === 'edit') void openInEditor(entry)
    else void download([entry])
  }

  /**
   * 在内置编辑器里打开。
   *
   * 远端**零副作用、本机零文件**：读一次字节、解一次码，失败就是失败、重试就是再读一次。
   * （上一版这里还得跟 startEdit 划清界限 —— 那条路会下载到本机临时目录、起一个外部
   * 进程、挂文件监视、并在整个编辑期间持有一个 8 态状态机。它已经被删掉了。）
   *
   * 到上限（同时 10 个）时 open 会抛，这里把那句人话显示出来 —— 静默不响应
   * 会让用户以为是这个文件打不开。
   */
  const openInEditor = async (entry: SftpEntry): Promise<void> => {
    if (!tab.sessionId) {
      message.warning(t('sftp.dropNoSession'))
      return
    }
    if (entry.badName) {
      message.warning(t('sftp.badNameWarning'))
      return
    }
    try {
      await useEditorStore.getState().open(tab.sessionId, entry.path)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const download = async (items: SftpEntry[]): Promise<void> => {
    if (!tab.sessionId) return
    const dir =
      settings.sftp.downloadDir ||
      (await ofs.invoke('app:pickPath', { mode: 'openDirectory', title: t('sftp.pickDownloadDir') }))
    if (!dir) return
    // 分隔符从下载目录本身看出来，不硬编码反斜杠（POSIX 宿主上会拼出一个名字里带 `\` 的文件）。
    // 落地名的 sanitize 在 main 侧统一做（transfer:enqueue 是所有下载的唯一入口）
    const base = dir.replace(/[\\/]$/, '')
    const sep = base.includes('\\') ? '\\' : '/'
    await enqueue(
      items.map((e) => ({
        sessionId: tab.sessionId!,
        kind: 'download' as const,
        remotePath: e.path,
        localPath: `${base}${sep}${e.name}`
      }))
    )
    message.success(t('sftp.enqueuedDownload', { count: items.length }))
  }

  /**
   * 等这次上传真正落地再刷新目录。
   *
   * 早先是 `setTimeout(1500)` 猜一次：大文件传完时早就刷过了，界面上永远看不到新文件。
   *
   * 判定分两半，缺一半都会错：
   * - **本次入队的 taskId 全部在 store 里露过面**。只看"有没有在跑的任务"会误判成立 ——
   *   enqueue 的回包比 transfer:state 事件先到，那一瞬间一个任务都还没进 store。
   * - **且这条会话没有排队/在跑的任务**。只看本次的 id 也不够 —— 目录任务在 main 侧
   *   展开成子任务后自己立刻变 done，只等它等于什么都没等。
   *   这一半成立靠一条时序：`expandIfDirectory` 先 enqueue 子任务（各发一条 queued），
   *   再把父任务置 done，事件按序到达，所以看见父任务 done 时子任务必然已在 store 里。
   *
   * 订阅必须在 enqueue **之前**建立，否则快速完成的小文件会把事件全漏在窗口外，
   * 只能等超时兜底。
   */
  const watchTransfers = (sessionId: SessionId): ((taskIds: string[]) => void) => {
    const activeCount = (): number =>
      useTransferStore
        .getState()
        .tasks.filter((task) => task.sessionId === sessionId && !TRANSFER_FINISHED.has(task.state))
        .length

    let watched: string[] | null = null
    const seen = new Set<string>()
    let off = (): void => {}

    const cleanup = (): void => {
      off()
      clearTimeout(timer)
      settleWatchersRef.current.delete(cleanup)
    }
    const check = (): void => {
      if (!watched) return
      for (const task of useTransferStore.getState().tasks) {
        if (watched.includes(task.id)) seen.add(task.id)
      }
      if (seen.size < watched.length || activeCount() > 0) return
      cleanup()
      void load(cwdRef.current, false)
    }
    const timer = setTimeout(() => {
      cleanup()
      void load(cwdRef.current, false)
    }, SETTLE_WATCH_TIMEOUT_MS)

    off = useTransferStore.subscribe(check)
    settleWatchersRef.current.add(cleanup)
    return (taskIds) => {
      watched = taskIds
      check()
    }
  }

  const uploadPaths = async (localPaths: string[], targetDir = cwd): Promise<void> => {
    const sessionId = tab.sessionId
    if (!sessionId) {
      message.warning(t('sftp.dropNoSession'))
      return
    }
    if (localPaths.length === 0) return
    const settle = watchTransfers(sessionId)
    const ids = await enqueue(
      localPaths.map((p) => ({
        sessionId,
        kind: 'upload' as const,
        localPath: p,
        remotePath: joinRemote(targetDir, p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'file')
      }))
    )
    message.success(t('sftp.enqueuedUpload', { count: localPaths.length }))
    settle(ids)
  }

  /** 只认真实文件拖拽（拖选中的文本、拖行内输入框都不该亮遮罩） */
  const isFileDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')

  const localPathsOf = (e: React.DragEvent): string[] =>
    [...e.dataTransfer.files]
      .map((f) => {
        try {
          return ofs.getPathForFile(f)
        } catch {
          return ''
        }
      })
      .filter(Boolean)

  const handleDrop = (e: React.DragEvent, targetDir: string): void => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    setDropTarget(null)
    if (!tab.sessionId) {
      message.warning(t('sftp.dropNoSession'))
      return
    }
    const paths = localPathsOf(e)
    if (paths.length === 0) {
      message.warning(t('sftp.dropUnsupported'))
      return
    }
    void uploadPaths(paths, targetDir)
  }

  const pickAndUpload = async (): Promise<void> => {
    const path = await ofs.invoke('app:pickPath', { mode: 'openFile', title: t('sftp.pickUpload') })
    if (path) await uploadPaths([path])
  }

  /**
   * 新建文件 / 文件夹。裸 Input + 闭包变量收值，沿用本文件既有的写法。
   *
   * onOk 里两处 throw 是**故意的**：antd 的约定是 onOk 抛错就把弹窗留在原地。
   * 空名或撞上同名时把弹窗关掉、让用户从右键菜单重新点一遍太狠 —— 名字还在框里，
   * 改一个字就能接着建。（代价是控制台会留一条未捕获的 rejection，本文件的删除/重命名同款。）
   */
  const promptNewEntry = (kind: 'file' | 'dir'): void => {
    let name = ''
    modal.confirm({
      title: kind === 'dir' ? t('sftp.newFolder') : t('sftp.newFile'),
      content: <Input autoFocus onChange={(e) => (name = e.target.value)} />,
      okText: t('common.ok'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        const trimmed = name.trim()
        if (!trimmed || !tab.sessionId) {
          message.warning(t('sftp.nameRequired'))
          throw new Error('empty name')
        }
        const path = joinRemote(cwd, trimmed)
        try {
          // 分两支写而不是把 channel 名三元出来：InvokeMap 的参数类型是按 channel 收窄的
          if (kind === 'dir') await ofs.invoke('sftp:mkdir', { sessionId: tab.sessionId, path })
          else await ofs.invoke('sftp:touch', { sessionId: tab.sessionId, path })
        } catch (err) {
          // 重名/无权限以前是静默失败的：弹窗一关，用户以为建好了
          message.error(err instanceof Error ? err.message : String(err))
          throw err
        }
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

  /**
   * 快速删除（在服务器上跑 `rm -rf`）。**与普通删除刻意做成两套确认**，不是同一个框换句文案：
   *
   *  - okText 用「我确认删除」而不是「删除」—— 避开在普通删除上练出来的肌肉记忆；
   *  - 一条 error 级 Alert 写明"直接执行 shell 命令、不进回收站"；
   *  - 把**将要执行的那条命令原文**等宽列出来。对一条 rm -rf 来说这是能给的最好的安全感受：
   *    用户亲眼看到引号是对的、路径是他选的那些。
   *
   * 命令来自 main 侧 `sftp:fastDeletePreview`，与真正执行的那条**共用同一个构造器** ——
   * 展示一条、执行另一条是这种界面最恶劣的失效方式。
   *
   * 守卫（绝对路径、无 `.`/`..`、非空路径段至少两级）在 preview 里就跑完，
   * 所以非法路径是在**弹框之前**被拒的，而不是等用户点完确认才报错。
   */
  const doFastDelete = async (items: SftpEntry[]): Promise<void> => {
    const sessionId = tab.sessionId
    if (!sessionId) {
      message.warning(t('sftp.waitingSession'))
      return
    }
    const paths = items.map((e) => e.path)
    let preview: { command: string; count: number; batches: number }
    try {
      preview = await ofs.invoke('sftp:fastDeletePreview', { paths })
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
      return
    }

    modal.confirm({
      title: t('sftp.fastDeleteTitle', { count: preview.count }),
      width: 640,
      icon: null,
      okText: t('sftp.fastDeleteOk'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      content: (
        <div>
          <Alert
            type="error"
            showIcon
            message={t('sftp.fastDeleteWarning')}
            style={{ marginBottom: 10 }}
          />
          <div className={styles.fastDeleteList}>
            {paths.slice(0, 10).map((p) => (
              <div key={p}>{p}</div>
            ))}
            {paths.length > 10 && (
              <div>{t('sftp.fastDeleteMore', { count: paths.length - 10 })}</div>
            )}
          </div>
          <div className={styles.fastDeleteHint}>{t('sftp.fastDeleteCommandLabel')}</div>
          <pre className={styles.fastDeleteCommand}>{preview.command}</pre>
          {preview.batches > 1 && (
            <div className={styles.fastDeleteHint} style={{ marginTop: 4 }}>
              {t('sftp.fastDeleteBatches', { count: preview.batches })}
            </div>
          )}
        </div>
      ),
      onOk: async () => {
        let result: { exitCode: number | null; leftover: string[]; stderr: string } | null = null
        let failure: unknown = null
        try {
          result = await ofs.invoke('sftp:fastDelete', { sessionId, paths })
        } catch (err) {
          failure = err
        }
        /*
         * 刷新只此一处，且**排在所有分支之前**：成功、部分未完成、结果未知、乃至整条
         * 调用抛错，每一种都可能已经删掉了一部分东西 —— 刷新后的列表才是事实来源。
         * 写成"每个分支各刷一次"迟早会漏掉一个分支，而漏掉的那次表现是"看着还在，其实没了"。
         */
        await load(cwd, false)
        if (failure !== null || result === null) {
          message.error(failure instanceof Error ? failure.message : String(failure))
          return
        }
        const tail = result.stderr ? firstLines(result.stderr, 5) : ''
        if (result.exitCode === null) {
          modal.error({ title: t('sftp.fastDeleteUnknown'), content: tail })
          return
        }
        if (result.leftover.length > 0) {
          modal.error({
            title: t('sftp.fastDeletePartial', { count: result.leftover.length }),
            content: (
              <div className={styles.fastDeleteList}>
                {result.leftover.slice(0, 10).map((p) => (
                  <div key={p}>{p}</div>
                ))}
                {tail && <pre className={styles.fastDeleteCommand}>{tail}</pre>}
              </div>
            )
          })
          return
        }
        if (result.exitCode !== 0) {
          // 目标确实都不在了，但 rm 报了非 0（子项权限之类）—— 说清楚而不是假装成功
          modal.error({ title: t('sftp.fastDeleteNonZero', { code: result.exitCode }), content: tail })
          return
        }
        message.success(t('sftp.fastDeleteDone', { count: preview.count }))
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

  /**
   * 行与空白处**共用同一份**菜单，靠"有没有目标"把条目变灰，而不是给两套 items ——
   * 两套迟早会走偏（FinalShell 也是一套：空白处右键时「打开」是灰的）。
   *
   * badName（文件名不是合法 UTF-8）一律禁用：以前只有「打开」拦了，重命名/删除/权限/
   * 复制路径照样能点，而那些路径发给服务器必然是错的字节。
   */
  /**
   * 一次操作实际作用于哪些条目：多选时"下载/删除"认整个选区，
   * 单选或右键了选区外的行时只认那一行。
   *
   * 菜单（算禁用态）与点击处理**必须用同一个函数**算这个 —— 分成两处写的后果是
   * "菜单上是灰的但点了有反应"或者反过来，而其中一处是 `rm -rf`。
   */
  const targetsFor = (target: SftpEntry | null): SftpEntry[] => {
    if (!target) return []
    return selectedEntries.length > 1 && selected.includes(target.path) ? selectedEntries : [target]
  }

  const contextItems = (target: SftpEntry | null): MenuProps['items'] => {
    const usable = target !== null && !target.badName
    // 重命名与权限只对单个目标有意义；多选时留着能点只会让人以为是批量改
    const single = usable && selectedEntries.length <= 1
    /*
     * 快速删除只对**目录**开放，而且要求这一批全是目录。
     *
     * 单个文件用 rm 一点都不快（SFTP unlink 就一个往返），而这个菜单项的每一分风险
     * 都是为了"删一棵几十万文件的树"这一件事付的 —— 给文件也放出来只是白担风险。
     * 混选时整条禁用而不是"只删其中的目录"：一个 rm -rf 不该悄悄改变用户选中的范围。
     */
    const dirTargets = targetsFor(target)
    const allDirs = usable && dirTargets.length > 0 && dirTargets.every((e) => isDir(e) && !e.badName)
    // 内置编辑器只吃文件。目录点进去、软链按它指向的东西算（isDir 已经处理了这一层）
    const viewable = usable && target !== null && !isDir(target)
    return [
      { key: 'refresh', label: t('sftp.refresh') },
      { type: 'divider' },
      { key: 'open', label: t('sftp.open'), disabled: !usable },
      /*
       * 内置编辑器。与上面那条「打开」并列，但两者现在**通向同一个地方** ——
       * 「打开」对文件就是在内置编辑器里打开（目录则是进去）。
       *
       * 那为什么还留两条？因为「打开」对目录和文件的含义不同，而这一条只对文件出现、
       * 名字里写明了去处。曾经它们是两条不同的路（「打开」= 起外部编辑器），
       * 那条已经删掉；合成一条得先决定目录该不该有"在编辑器里打开"，不属于本片。
       */
      { key: 'view', label: t('sftp.viewInEditor'), disabled: !viewable },
      { type: 'divider' },
      { key: 'copyPath', label: t('sftp.copyPath'), disabled: !usable },
      { type: 'divider' },
      { key: 'download', label: t('sftp.download'), disabled: !usable },
      { key: 'upload', label: t('sftp.uploadMenu') },
      /*
       * 打包传输是**勾选项**，写的是全局设置（与工具栏那个"显示隐藏文件"完全同款）。
       * 它是**建议性**的：main 侧会自己判断值不值得（文件数、远端有没有 tar/mktemp、
       * 空间够不够、冲突策略），付不起就静默退回逐文件并在那条任务上说明原因。
       * 所以这里的文案不能写成"打包传输（一定会打包）"。
       */
      {
        key: 'packedTransfer',
        label: t('sftp.packedTransfer'),
        icon: settings.sftp.packedTransfer ? <Check size={13} strokeWidth={2} /> : undefined
      },
      { type: 'divider' },
      {
        key: 'new',
        label: t('sftp.new'),
        children: [
          { key: 'newFile', label: t('sftp.kindFile') },
          { key: 'newFolder', label: t('sftp.kindFolder') }
        ]
      },
      { type: 'divider' },
      { key: 'rename', label: t('common.rename'), disabled: !single },
      { key: 'delete', label: t('common.delete'), danger: true, disabled: !usable },
      // 关掉设置只是不显示这一项；main 侧的守卫与这个开关无关
      ...(settings.sftp.fastDelete
        ? [{ key: 'fastDelete', label: t('sftp.fastDelete'), danger: true, disabled: !allDirs }]
        : []),
      { type: 'divider' as const },
      { key: 'perm', label: t('sftp.permissions'), disabled: !single }
    ]
  }

  const onContextClick = (target: SftpEntry | null, key: string): void => {
    // 与目标无关的三条先走，它们在空白处右键时也是活的
    if (key === 'refresh') {
      void load(cwd, false)
      return
    }
    if (key === 'upload') {
      void pickAndUpload()
      return
    }
    if (key === 'newFile' || key === 'newFolder') {
      promptNewEntry(key === 'newFile' ? 'file' : 'dir')
      return
    }
    if (key === 'packedTransfer') {
      patchSettings({ sftp: { ...settings.sftp, packedTransfer: !settings.sftp.packedTransfer } })
      return
    }
    if (!target) return
    const targets = targetsFor(target)
    if (key === 'open') openEntry(target, 'edit')
    else if (key === 'view') void openInEditor(target)
    else if (key === 'download') void download(targets)
    else if (key === 'rename') setRenamingPath(target.path)
    else if (key === 'perm') setPermTarget(target)
    else if (key === 'copyPath') void navigator.clipboard.writeText(target.path)
    else if (key === 'delete') doDelete(targets)
    else if (key === 'fastDelete') void doFastDelete(targets)
  }

  /**
   * 受控菜单只好自己收尾。trigger={[]} 意味着 rc-trigger 一个交互都不接管：
   * 它挂"点外面关掉"的文档监听是跟着 action 走的，没有 action 就没有监听，
   * 于是 onOpenChange 永远不会因为点击外部而触发（菜单赖着不走），
   * 而 fixed 定位的锚点也不随表格滚动 —— 菜单会停在旧坐标上飘着。
   *
   * 那为什么不用默认 trigger？默认 trigger 得把 Dropdown 套在行元素上，
   * 而 virtual 模式下 antd 的单元格是 div，不能覆写 row 组件（套 <tr> 是非法 DOM 嵌套）。
   *
   * 三个细节：
   * - pointerdown 走捕获阶段，但**放过菜单自身** —— 菜单项激活靠的是随后那个 click，
   *   在 pointerdown 就无条件关会让每次点击都落空。判据不能只取 .ant-dropdown：
   *   子菜单（新建 >）是另一个 portal，外层挂的是 -menu-submenu，里面那层 ul 才带
   *   -menu（rc-menu 的 SubMenuList 会把裸 prefixCls 也加上），两个都放过才点得动。
   * - scroll 也要捕获：滚动事件不冒泡，只有捕获阶段收得到表格内部滚动容器那一条。
   * - Esc 关菜单得自己来：菜单没拿焦点，antd 收不到键。
   */
  useEffect(() => {
    if (!contextMenu) return
    const close = (): void => setContextMenu(null)
    const onPointerDown = (e: PointerEvent): void => {
      const el = e.target
      if (el instanceof Element && el.closest('.ant-dropdown-menu, .ant-dropdown-menu-submenu')) {
        return
      }
      close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [contextMenu])

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
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        dragDepthRef.current += 1
        setDragOver(true)
      }}
      onDragOver={(e) => {
        // preventDefault 是"允许在这里放下"的唯一表达方式，必须每次 dragover 都给
        if (isFileDrag(e)) e.preventDefault()
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) {
          setDragOver(false)
          setDropTarget(null)
        }
      }}
      onDrop={(e) => handleDrop(e, dropTarget ?? cwd)}
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
          <Button
            size="small"
            type="text"
            icon={<FolderPlus size={14} strokeWidth={1.75} />}
            onClick={() => promptNewEntry('dir')}
          />
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

      {/* 空白处右键也要出菜单（FinalShell 同款）：onRow 只覆盖到行上，
          表头、行下面的空白区、乃至"加载中/出错"这几个占位都落在这个容器上 */}
      <div
        className={styles.table}
        onContextMenu={(e) => {
          e.preventDefault()
          // 目标为空的菜单要与"没有选中项"对得上，否则灰掉的条目会显得莫名其妙
          setSelected([])
          setContextMenu({ x: e.clientX, y: e.clientY, entry: null })
        }}
      >
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
            rowClassName={(entry) => (dropTarget === entry.path ? styles.dropRow : '')}
            onRow={(entry) => ({
              onDoubleClick: () =>
                openEntry(entry, settings.sftp.doubleClickAction === 'open' ? 'edit' : 'download'),
              // 拖到目录行上 → 上传进那个目录（uploadPaths 的 targetDir 一直是预留好的）
              onDragOver: (e) => {
                if (!isFileDrag(e) || !isDir(entry) || entry.badName) return
                e.preventDefault()
                setDropTarget(entry.path)
              },
              onDragLeave: () => {
                // 从 A 移到 B 时两个事件的先后没有保证，只清掉确实是自己的那个
                setDropTarget((prev) => (prev === entry.path ? null : prev))
              },
              onDrop: (e) => {
                if (!isDir(entry) || entry.badName) return
                e.stopPropagation()
                handleDrop(e, entry.path)
              },
              onContextMenu: (e) => {
                // 不覆写 row 组件：virtual 模式下 antd 的单元格是 div，
                // 强行套在 <tr> 上会产生非法 DOM 嵌套。改为在光标处开受控菜单。
                e.preventDefault()
                // 必须拦住冒泡：否则容器上那个"空白处菜单"随后又把 entry 抹成 null
                e.stopPropagation()
                if (!selected.includes(entry.path)) setSelected([entry.path])
                setContextMenu({ x: e.clientX, y: e.clientY, entry })
              }
            })}
          />
        )}
      </div>

      {contextMenu && (
        <Dropdown
          /* 换坐标靠重挂载：open 一直是 true 时 rc-trigger 不会因为锚点位移而重新对齐，
             不换 key 就会出现"在 B 行右键、菜单还停在 A 行"的怪相 */
          key={`${contextMenu.x},${contextMenu.y}`}
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

      {dragOver && (
        <div className={styles.dropMask}>
          {t('sftp.dropToUpload', { dir: dropTarget ?? cwd })}
        </div>
      )}

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
