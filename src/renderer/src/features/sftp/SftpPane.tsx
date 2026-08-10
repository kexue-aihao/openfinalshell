import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Dropdown,
  Empty,
  Input,
  Skeleton,
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
  FolderUp,
  RefreshCw,
  Upload
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionId, SftpEntry, TransferConflictAction } from '@shared/types'
import { TRANSFER_FINAL_STATES } from '@shared/constants'
import { ofs } from '@/ipc/api'
import { useEditorStore } from '@/stores/useEditorStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTransferStore } from '@/stores/useTransferStore'
import type { SessionTab } from '@/stores/useSessionStore'
import { formatBytes, formatTimestamp } from '@/utils/format'
import { snapOf } from '@/features/transfers/aggregate'
import { onShellCommand } from '@/features/terminal/commandEvents'
import { applyCd, navView, parseCdTarget } from './pathSync'
import { FileIcon } from './FileIcon'
import { PermissionModal } from './PermissionModal'
import { UploadConflictModal, type UploadRequest } from './UploadConflictModal'
import styles from './SftpPane.module.css'

interface Props {
  tab: SessionTab
  active: boolean
}

/** 终态集合只有 @shared/constants 那一份。漏了新终态，watchTransfers 就永远等不完 */
const TRANSFER_FINISHED = TRANSFER_FINAL_STATES

/**
 * 目录判定：symlink 要看指向。纯函数，放模块级 —— 组件里当它是稳定引用，
 * 于是 columns 的 useMemo 不用把它列进依赖（列进去每次渲染都变，memo 就白做了）。
 */
const isDirEntry = (e: SftpEntry): boolean =>
  e.type === 'dir' || (e.type === 'symlink' && e.targetType === 'dir')

/** 远端命令的 stderr 只给人看前几行：一次 rm -rf 失败可能刷出上千行 Permission denied */
function firstLines(text: string, n: number): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines.length <= n ? lines.join('\n') : `${lines.slice(0, n).join('\n')}\n…`
}
/**
 * 兜底：队列**空转**这么久就认为卡住了，刷一次并退订。队列在动就不断刷新这个时钟，
 * 所以传一千个文件也不会中途退订（见 watchTransfers 里的说明）。
 */
const SETTLE_IDLE_TIMEOUT_MS = 60_000
const SETTLE_IDLE_CHECK_MS = 5_000
/** 绝对上限：再活跃也不无限期挂着订阅 */
const SETTLE_MAX_WATCH_MS = 6 * 3600_000

/** 本地路径的最后一段（Windows 与 POSIX 分隔符都吃）。上传的落地名就是它 */
function baseNameOf(localPath: string): string {
  return localPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'file'
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
  /**
   * 正在导航去的目录（乐观值）。**只给显示用** —— 面包屑/路径框立刻翻到它，
   * 于是"按下回车"与"路径变了"是同一帧的事，不再等一个网络往返。
   *
   * 写操作（新建/上传/拖放/重命名/删除）一律继续读 `cwd`，也就是**已确认**的目录：
   * 这样即便乐观值最终失败（cd 打错了、没权限），也不可能把文件写到一个没去成的目录里。
   */
  const [pendingDir, setPendingDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [history, setHistory] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 })
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [permTarget, setPermTarget] = useState<SftpEntry | null>(null)
  /** 非 null = 有一批上传正在等冲突裁决（探测中或已在问） */
  const [uploadRequest, setUploadRequest] = useState<UploadRequest | null>(null)
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
  /** 会话初始化时 realpath('.') 的结果，cd 跟随解析 `~` 用；拿不到时 ~ 类目标不跟 */
  const homeRef = useRef<string | null>(null)
  /** 导航代号：每次 load 自增，回包时对不上就是过期回包（见 load 里的说明） */
  const loadSeqRef = useRef(0)
  /** 报错时那次要去的目录 —— 「重试」重试的是**失败的那个**，而不是当前还待着的这个 */
  const errorDirRef = useRef<string | null>(null)
  useEffect(
    () => () => {
      for (const off of settleWatchersRef.current) off()
      settleWatchersRef.current.clear()
    },
    []
  )

  const showHidden = settings.sftp.showHiddenFiles

  const load = useCallback(
    async (dir: string, pushHistory = true, silentErrors = false): Promise<void> => {
      if (!tab.sessionId) return
      /*
       * 每次导航领一个代号。回包时代号不再是最新的，说明期间又导航过一次 ——
       * 这一份是**过期回包**，一个 state 都不许碰。
       *
       * 不做这件事的后果：`cd /a` 紧接着 `cd /b`（或双击很快点两下），两个 readdir
       * 并发在飞，谁先回来不保证。/a 的回包后到就会把面板压回 /a，而面包屑显示的是
       * /b —— 用户看到的是"跳错了目录"，且刷新一下就好，最难查的那类。
       */
      const seq = ++loadSeqRef.current
      setLoading(true)
      /*
       * 乐观切路径：面包屑与路径框立刻显示目标目录，列表位置换成骨架。
       * **绝不动 entries** —— 置空会让 `tab.state !== 'ready' && entries.length === 0`
       * 那条整面板 early return 在会话抖一下时把整个面板顶成"等待会话"，且再也回不来。
       */
      setPendingDir(dir)
      // silent 模式（cd 跟随）失败时整个面板一个字都不动 —— 连既有的错误框都不碰
      if (!silentErrors) setError(null)
      try {
        const list = await ofs.invoke('sftp:readdir', { sessionId: tab.sessionId, path: dir })
        if (seq !== loadSeqRef.current) return
        setEntries(list)
        setCwd(dir)
        setSelected([])
        /*
         * 成功就**一定**清错。原先这一句也被 `!silentErrors` 包着，于是：一次失败留下
         * 错误空态 → 之后 cd 跟随（silent）成功了也不清 → 表格被错误空态永久顶掉，
         * 表现成"跟随彻底坏了"，只能手动点刷新。
         */
        setError(null)
        errorDirRef.current = null
        if (pushHistory) {
          setHistory((h) => {
            const stack = [...h.stack.slice(0, h.index + 1), dir]
            return { stack, index: stack.length - 1 }
          })
        }
      } catch (err) {
        if (seq !== loadSeqRef.current) return
        if (!silentErrors) {
          setError(err instanceof Error ? err.message : String(err))
          errorDirRef.current = dir
        }
      } finally {
        // 被更新的导航取代时不碰这两样：那属于新请求，它自己会收尾
        if (seq === loadSeqRef.current) {
          setLoading(false)
          setPendingDir(null)
        }
      }
    },
    [tab.sessionId]
  )

  // 首次打开：解析 home 目录（记下来给 cd 跟随解析 `~`；解析不到就没有 ~ 跟随）
  useEffect(() => {
    if (initializedRef.current || !tab.sessionId || tab.state !== 'ready') return
    initializedRef.current = true
    void ofs
      .invoke('sftp:realpath', { sessionId: tab.sessionId, path: '.' })
      .then((home) => {
        homeRef.current = home
        return load(home)
      })
      .catch(() => load('/'))
  }, [tab.sessionId, tab.state, load])

  // 终端 cd → 面板跟随。解析纯逻辑在 pathSync.ts；推导不出目标（cd -、$VAR、~user）
  // 或目标读不到（打错了、无权限）都原地不动 —— 终端自己已经把 cd 的错误给用户看了
  useEffect(() => {
    if (!settings.sftp.followTerminalCd) return
    return onShellCommand(tab.id, (command) => {
      const target = parseCdTarget(command)
      if (!target) return
      const next = applyCd(cwdRef.current, target, homeRef.current)
      if (!next || next === cwdRef.current) return
      void load(next, true, true)
    })
  }, [tab.id, settings.sftp.followTerminalCd, load])

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

  const isDir = isDirEntry

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
   *   enqueue 的回包比 transfer:states 事件先到，那一瞬间一个任务都还没进 store。
   * - **且这条会话没有排队/在跑的任务**。只看本次的 id 也不够 —— 目录任务在 main 侧
   *   展开成子任务后自己立刻变 done，只等它等于什么都没等。
   *   这一半成立靠一条时序：`expandIfDirectory` 先 enqueue 子任务（各发一条 queued），
   *   再把父任务置 done，事件按序到达，所以看见父任务 done 时子任务必然已在 store 里。
   *
   * 订阅必须在 enqueue **之前**建立，否则快速完成的小文件会把事件全漏在窗口外，
   * 只能等超时兜底。
   */
  const watchTransfers = (sessionId: SessionId): ((taskIds: string[]) => void) => {
    /**
     * 会话里还没进终态的任务数 + 已传字节和：当"它还在动吗"的廉价指纹。
     *
     * ⚠️ 字节必须走 `snapOf` 从**进度 overlay** 里读。进度事件不写 tasks
     * （见 useTransferStore 的热/冷分离），直接读 `task.transferred` 拿到的是陈旧值 ——
     * 那会让一个跑十分钟的大文件在 60 秒后被判成"空转"，于是提前退订、
     * 真正传完那一刻反而不刷新，正是这次要修掉的毛病。
     */
    const fingerprint = (): { active: number; bytes: number } => {
      const { tasks, progress } = useTransferStore.getState()
      let active = 0
      let bytes = 0
      for (const task of tasks) {
        if (task.sessionId !== sessionId) continue
        if (!TRANSFER_FINISHED.has(task.state)) active += 1
        bytes += snapOf(task, progress).transferred
      }
      return { active, bytes }
    }

    let watched: string[] | null = null
    const seen = new Set<string>()
    let off = (): void => {}
    const startedAt = Date.now()
    let lastActivityAt = Date.now()
    let lastBytes = -1

    const cleanup = (): void => {
      off()
      clearInterval(timer)
      settleWatchersRef.current.delete(cleanup)
    }
    const settleNow = (): void => {
      cleanup()
      void load(cwdRef.current, false)
    }
    const check = (): void => {
      if (!watched) return
      for (const task of useTransferStore.getState().tasks) {
        if (watched.includes(task.id)) seen.add(task.id)
      }
      const fp = fingerprint()
      if (fp.bytes !== lastBytes) {
        lastBytes = fp.bytes
        lastActivityAt = Date.now()
      }
      if (seen.size < watched.length || fp.active > 0) return
      settleNow()
    }
    /*
     * 兜底从"一刀切 120 秒"换成**空转判定**。
     *
     * 固定 120 秒在批量上传下必然先到点：传 1000 个文件时它会刷一次、然后退订，
     * 于是真正传完那一刻不再刷新 —— 用户看到的是一份中途列表。
     *
     * 也**不按任务数放大**：决定耗时的是吞吐不是条数（1000 个 1KB 文件可能 20 秒，
     * 3 个 20GB 要几小时），按条数算的系数在两个方向上都是错的。这里直接量
     * "它还在不在动"，另加一个绝对上限，免得订阅无限期挂着。
     */
    const timer = setInterval(() => {
      const now = Date.now()
      if (now - lastActivityAt > SETTLE_IDLE_TIMEOUT_MS || now - startedAt > SETTLE_MAX_WATCH_MS) {
        settleNow()
      }
    }, SETTLE_IDLE_CHECK_MS)

    off = useTransferStore.subscribe(check)
    settleWatchersRef.current.add(cleanup)
    return (taskIds) => {
      watched = taskIds
      check()
    }
  }

  const uploadPaths = async (
    localPaths: string[],
    targetDir: string,
    onConflict: TransferConflictAction | undefined
  ): Promise<void> => {
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
        remotePath: joinRemote(targetDir, baseNameOf(p)),
        ...(onConflict ? { onConflict } : {})
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
    startUpload(paths, targetDir)
  }

  /**
   * 所有上传入口的唯一汇合点。
   *
   * 三层分工：取路径（pickAndUpload / handleDrop）→ 这里 → 冲突裁决 → uploadPaths（入队）。
   * 中间这一层存在的意义是"入队前该做的事只有一处"。所以
   * **uploadPaths 全文件只许有一个调用点**：日后新加的上传入口若绕过裁决，
   * 表现就是多出第二个 `uploadPaths(` 调用点，护栏能看见。
   *
   * 拖拽也走这里 —— 拖 200 个文件覆盖远端与用对话框选 200 个一样危险，
   * 而拖拽恰好是今天唯一能一次带进整棵目录树的入口。
   */
  const startUpload = (localPaths: string[], targetDir: string): void => {
    const sessionId = tab.sessionId
    if (!sessionId) {
      message.warning(t('sftp.dropNoSession'))
      return
    }
    if (localPaths.length === 0) return
    // 上一批还在探测：不排队第二个请求（排队意味着要连点两次确认框，
    // 而用户早忘了第一次选的是什么）
    if (uploadRequest) {
      message.warning(t('sftp.uploadBusy'))
      return
    }
    /*
     * 设置里的 conflictPolicy 决定"要不要问"：
     * - 'ask'（默认）→ 探测，有冲突就弹框；
     * - 其余三值 → 不问，直接把该动作填进每一条（探测仍然要跑：skip 得知道跳哪些、
     *   rename 得算新名，那都在 main 侧的 planConflicts 里做）。
     * 这就是那个从来没有界面的设置项第一次有意义的地方。
     */
    const policy = settings.sftp.conflictPolicy
    if (policy !== 'ask') {
      proceedUpload(localPaths, targetDir, policy === 'resume' ? 'overwrite' : policy)
      return
    }
    setUploadRequest({
      sessionId,
      targetDir,
      localPaths,
      names: localPaths.map(baseNameOf)
    })
  }

  /** 唯一调用 uploadPaths 的地方（见上面那条不变量） */
  const proceedUpload = (
    localPaths: string[],
    targetDir: string,
    action: TransferConflictAction | undefined
  ): void => {
    setUploadRequest(null)
    void uploadPaths(localPaths, targetDir, action)
  }

  /**
   * 从对话框选路径。**必须分两个 mode 各来一次**：Windows/Linux 上
   * `properties: ['openFile','openDirectory']` 会静默退化成只能选目录（见 app.ipc.ts），
   * 所以界面上是两个入口，而不是一个"选文件或文件夹"。
   */
  const pickAndUpload = async (kind: 'file' | 'folder', targetDir = cwd): Promise<void> => {
    const paths = await ofs.invoke('app:pickPaths', {
      mode: kind === 'folder' ? 'openDirectory' : 'openFile',
      title: kind === 'folder' ? t('sftp.pickUploadFolder') : t('sftp.pickUpload')
    })
    if (paths.length === 0) return
    startUpload(paths, targetDir)
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

  // useCallback：columns 用 useMemo 缓存，doRename 稳定才能让选中/拖拽等高频状态变化
  // 不去重建整份 columns（重建会逼虚拟表格重算列布局）
  const doRename = useCallback(
    async (entry: SftpEntry, newName: string): Promise<void> => {
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
    },
    [tab.sessionId, cwd, load, message]
  )

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

  // 缓存整份 columns：只有 t / 正在重命名的行 / doRename 变时才重建。
  // 不缓存的话，选中一行、拖拽悬停、cd 跟随刷新等高频状态变化都会重建 columns，
  // 逼 antd 虚拟表格重新测算列宽、把可见行全量重渲染（500 条目录里实测每次约 26ms）
  const columns: TableColumnsType<SftpEntry> = useMemo(() => [
    {
      title: t('sftp.colName'),
      dataIndex: 'name',
      ellipsis: true,
      sorter: (a: SftpEntry, b: SftpEntry) => a.name.localeCompare(b.name),
      render: (_: unknown, entry: SftpEntry) => (
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
      sorter: (a: SftpEntry, b: SftpEntry) => a.size - b.size,
      render: (size: number, entry: SftpEntry) =>
        isDirEntry(entry) ? '-' : <Tooltip title={`${size} B`}>{formatBytes(size)}</Tooltip>
    },
    {
      title: t('sftp.colMode'),
      dataIndex: 'modeStr',
      width: 104,
      render: (modeStr: string, entry: SftpEntry) => (
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
      sorter: (a: SftpEntry, b: SftpEntry) => a.mtime - b.mtime,
      render: (mtime: number) => formatTimestamp(mtime)
    }
  ], [t, renamingPath, doRename])

  // Set 成员判定 O(1)：selected 是数组，includes 在选区大时是 O(n·m)。
  // selectedEntries 同样缓存 —— 它喂给 targetsFor，且每次渲染都算一遍没必要
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const selectedEntries = useMemo(
    () => visible.filter((e) => selectedSet.has(e.path)),
    [visible, selectedSet]
  )

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
    return selectedEntries.length > 1 && selectedSet.has(target.path) ? selectedEntries : [target]
  }

  /**
   * 上传的落点。**与 targetsFor 同源**：右键在单个合法目录上时传进那个目录，其余情况
   * （多选、文件、badName、空白处）一律退回 cwd —— 与"拖到文件行上退回当前目录"
   * （onRow 的 onDrop 里那个 !isDir 判断）是同一条规则。
   *
   * 菜单标签与真正执行的目录**必须走这一个函数**：分成两处算的后果是菜单上写着
   * 「上传到 logs」、文件却落进了当前目录，而且没有任何报错。
   */
  const uploadDirFor = (target: SftpEntry | null): { dir: string; name: string | null } => {
    const ts = targetsFor(target)
    const only = ts.length === 1 ? ts[0] : null
    return only && isDir(only) && !only.badName
      ? { dir: only.path, name: only.name }
      : { dir: cwd, name: null }
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
    const uploadInto = uploadDirFor(target)
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
      /*
       * 两个子项而不是一条「上传…」：见 pickAndUpload 上的说明（一个对话框没法同时
       * 多选文件和文件夹）。整条永不禁用 —— 落点是目录（cwd 或右键中的那个目录），
       * 与有没有选中项无关，所以它属于"与目标无关的先走"那一族。
       */
      {
        key: 'upload',
        label: uploadInto.name
          ? t('sftp.uploadIntoMenu', { dir: uploadInto.name })
          : t('sftp.uploadMenu'),
        children: [
          { key: 'uploadFile', label: t('sftp.uploadFile') },
          { key: 'uploadFolder', label: t('sftp.uploadFolder') }
        ]
      },
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
    // 空白处右键也要能上传，所以这两条必须排在下面 `if (!target) return` 之前
    if (key === 'uploadFile' || key === 'uploadFolder') {
      void pickAndUpload(key === 'uploadFolder' ? 'folder' : 'file', uploadDirFor(target).dir)
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

  // 显示派生（规则与"为什么是纯函数"见 pathSync.navView）
  const { displayDir, navPending } = navView(cwd, pendingDir)

  const crumbs = useMemo(() => {
    const segs = displayDir.split('/').filter(Boolean)
    return [{ label: '/', path: '/' }, ...segs.map((s, i) => ({ label: s, path: `/${segs.slice(0, i + 1).join('/')}` }))]
  }, [displayDir])

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
        // 换目录途中不接拖放：落点 cwd 还是上一个目录（与工具栏那三个按钮同一条理由）
        if (!isFileDrag(e) || navPending) return
        e.preventDefault()
        dragDepthRef.current += 1
        setDragOver(true)
      }}
      onDragOver={(e) => {
        // preventDefault 是"允许在这里放下"的唯一表达方式，必须每次 dragover 都给
        if (isFileDrag(e) && !navPending) e.preventDefault()
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
          <div className={styles.breadcrumbBar} onClick={() => setEditingPath(displayDir)}>
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
            defaultValue={displayDir}
            onPressEnter={(e) => {
              const value = (e.target as HTMLInputElement).value.trim()
              setEditingPath(null)
              if (value) void load(value)
            }}
            onBlur={() => setEditingPath(null)}
          />
        )}

        {/* 换目录途中禁掉三个写入口：此刻 cwd 还是上一个目录，
            在这里新建/上传会把东西落在用户已经离开的目录里（cd 打错时更明显） */}
        <Tooltip title={t('sftp.newFolder')}>
          <Button
            size="small"
            type="text"
            disabled={navPending}
            icon={<FolderPlus size={14} strokeWidth={1.75} />}
            onClick={() => promptNewEntry('dir')}
          />
        </Tooltip>
        {/* 两个按钮而不是一个带下拉：这一行从头到尾是"单击即执行"的图标按钮，
            插一个"点开才有内容"的下拉是唯一的异类；而合成一个对话框做不到
            （见 pickAndUpload 上的说明） */}
        <Tooltip title={t('sftp.uploadFile')}>
          <Button
            size="small"
            type="text"
            disabled={navPending}
            icon={<Upload size={14} strokeWidth={1.75} />}
            onClick={() => void pickAndUpload('file')}
          />
        </Tooltip>
        <Tooltip title={t('sftp.uploadFolder')}>
          <Button
            size="small"
            type="text"
            disabled={navPending}
            icon={<FolderUp size={14} strokeWidth={1.75} />}
            onClick={() => void pickAndUpload('folder')}
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
                  {/* 重试的是失败的那个目录，不是脚下这个（脚下这个本来就是好的） */}
                  <a onClick={() => void load(errorDirRef.current ?? cwd, false)}>
                    {t('common.retry')}
                  </a>
                </span>
              }
            />
          </div>
        ) : navPending ? (
          /*
           * 换目录途中的骨架。用它**替代** <Table> 而不是盖在上面，是因为这样
           * 行上的双击/拖放/右键、以及 rowSelection 全部自动失活 —— 不用逐个加守卫，
           * 也就不会漏掉某一个入口去操作一个还没确认存在的目录里的旧条目。
           * 刻意不放任何文案：一是无需新增 10 份 locale，二是"骨架"本身就已经在说"在读了"。
           */
          <div className={styles.skeletonWrap} aria-busy>
            <Skeleton active title={false} paragraph={{ rows: 6, width: '100%' }} />
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
            // 双击进目录要跨一个网络往返（真机上是延迟卡显示的那个 RTT）。这期间旧内容
            // 还留着、界面看起来"没反应"——加一个 150ms 延迟出现的转圈：本地/秒开的
            // 目录一闪都不闪，慢链路上则立刻确认"点到了、在读了"。首次加载（空表）同样受用
            loading={{ spinning: loading, delay: 150 }}
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

      <UploadConflictModal
        request={uploadRequest}
        onCancel={() => setUploadRequest(null)}
        onProceed={(action) => {
          if (!uploadRequest) return
          proceedUpload(uploadRequest.localPaths, uploadRequest.targetDir, action)
        }}
      />

      {!active && null}
    </div>
  )
}
