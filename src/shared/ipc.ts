/**
 * IPC 契约 —— 全项目唯一事实来源。
 * main / preload / renderer 三层都只从这里取 channel 名与 payload 类型。
 *
 * 三张 map：
 *  - InvokeMap  renderer → main 请求/响应（ipcRenderer.invoke / ipcMain.handle）
 *  - SendMap    renderer → main 高频单向（ipcRenderer.send / ipcMain.on）
 *  - EventMap   main → renderer 事件（webContents.send）
 */
import type {
  AppSettings,
  AppVersions,
  ConnectionGroup,
  ConnectionProfile,
  EditId,
  EolWarning,
  ForwardId,
  ForwardRule,
  ForwardRuntime,
  GroupId,
  ImportApplyOptions,
  ImportPreview,
  ImportResult,
  MonitorSnapshot,
  MonitorState,
  MonitorStaticInfo,
  ProfileDraft,
  ProfileId,
  RemoteEditEntry,
  RemoteEditState,
  SessionId,
  SessionPrompt,
  SessionPromptReply,
  SessionState,
  SftpEntry,
  Snippet,
  SnippetGroup,
  TaskId,
  TermId,
  TransferEnqueueItem,
  TransferTask
} from './types'

// ---------------------------------------------------------------------------
// ① renderer → main，请求/响应
// ---------------------------------------------------------------------------
export interface InvokeMap {
  // --- 应用 ---
  'app:getVersions': { args: []; result: AppVersions }
  'app:pickPath': {
    args: [{ mode: 'openFile' | 'saveFile' | 'openDirectory'; defaultPath?: string; title?: string }]
    result: string | null
  }
  'app:openExternal': { args: [string]; result: void }
  'app:openPath': { args: [string]; result: void }
  /** 导出应用数据；取消保存对话框返回 null。口令只单向进 main，不回传 */
  'app:exportData': {
    args: [{ includeSecrets: boolean; passphrase?: string }]
    result: { path: string; bytes: number; profiles: number; secrets: number } | null
  }
  /** 选文件并解析导出文件，返回概要供用户确认；取消对话框返回 null */
  'app:importPreview': { args: []; result: ImportPreview | null }
  /** 按 importPreview 给的 token 真正写入 */
  'app:importData': { args: [ImportApplyOptions]; result: ImportResult }

  // --- 设置 ---
  'settings:get': { args: []; result: AppSettings }
  'settings:set': { args: [Partial<AppSettings>]; result: AppSettings }

  // --- Vault ---
  'vault:isAvailable': { args: []; result: boolean }

  // --- 连接配置 ---
  'conn:list': { args: []; result: { profiles: ConnectionProfile[]; groups: ConnectionGroup[] } }
  'conn:save': { args: [ProfileDraft]; result: ConnectionProfile }
  'conn:delete': { args: [ProfileId]; result: void }
  'conn:duplicate': { args: [ProfileId]; result: ConnectionProfile }
  'group:save': { args: [ConnectionGroup]; result: void }
  'group:delete': { args: [GroupId]; result: void }

  // --- 会话生命周期 ---
  'session:open': { args: [ProfileId]; result: { sessionId: SessionId } }
  'session:close': { args: [SessionId]; result: void }
  'session:reconnect': { args: [SessionId]; result: void }
  'session:promptReply': { args: [SessionPromptReply]; result: void }

  // --- 终端 ---
  'term:open': { args: [{ sessionId: SessionId; cols: number; rows: number }]; result: { termId: TermId } }
  'term:resize': { args: [{ termId: TermId; cols: number; rows: number }]; result: void }
  'term:close': { args: [TermId]; result: void }
  /** 快捷命令：写入命令文本（autoEnter 时附 \n） */
  'term:exec': { args: [{ termId: TermId; command: string }]; result: void }

  // --- SFTP 浏览 ---
  'sftp:readdir': { args: [{ sessionId: SessionId; path: string }]; result: SftpEntry[] }
  'sftp:realpath': { args: [{ sessionId: SessionId; path: string }]; result: string }
  'sftp:mkdir': { args: [{ sessionId: SessionId; path: string }]; result: void }
  'sftp:rename': { args: [{ sessionId: SessionId; from: string; to: string }]; result: void }
  'sftp:delete': { args: [{ sessionId: SessionId; path: string; recursive: boolean }]; result: void }
  'sftp:chmod': { args: [{ sessionId: SessionId; path: string; mode: number }]; result: void }
  /** 新建空文件（右键「新建 > 文件」）：目标已存在即报错，绝不静默覆盖 */
  'sftp:touch': { args: [{ sessionId: SessionId; path: string }]; result: void }

  // --- 快速删除（在服务器上跑 rm -rf） ---
  /**
   * 生成将要执行的那条命令，给确认框原样展示。**纯的、无副作用**，所以不收 sessionId。
   *
   * 守卫（绝对路径、无换行/`.`/`..`、非空路径段至少两级）在这里就跑完 ——
   * 非法路径在**弹框之前**就被拒，不会等用户点完"我确认删除"才报错。
   * batches > 1 时 command 是第一批的，界面要如实说明"共 N 批"。
   */
  'sftp:fastDeletePreview': {
    args: [{ paths: string[] }]
    result: { command: string; count: number; batches: number }
  }
  /**
   * 真的删。守卫在 main 侧**重跑一遍** —— 绝不假设 preview 被调过（这是两条独立 channel）。
   *
   * 结果三分：`exitCode===0 && leftover 为空` = 成功；有 leftover = 部分未完成；
   * `exitCode===null` = 拿不到退出码（中途断连），一律当"未知"、**永不当成功**。
   * 三种情况界面都要刷新列表 —— 刷新后的列表才是事实来源。
   */
  'sftp:fastDelete': {
    args: [{ sessionId: SessionId; paths: string[] }]
    result: { exitCode: number | null; leftover: string[]; stderr: string }
  }

  // --- 远端文件编辑 ---
  /**
   * 拉到本机临时目录、起编辑器、盯存盘。同一会话同一路径重复调 = 把编辑器再唤一次。
   * 参数里只有远端路径 —— 本地路径由 main 从 (sessionId, path) 派生，
   * 这一条是整条链路的安全前提（见 main/ipc/sftp.ipc.ts 顶部）。
   */
  'sftp:editOpen': { args: [{ sessionId: SessionId; path: string }]; result: RemoteEditEntry }
  /** 该会话下还活着的编辑（不含 closed）。界面重挂载后靠它对齐列表 */
  'sftp:editList': { args: [{ sessionId: SessionId }]; result: RemoteEditEntry[] }
  /**
   * 用户显式确认后的"仍然覆盖"：**跳过冲突检测**，conflict / blocked 两态的出口。
   * **必须带 force: true** —— 普通存盘由本地文件监视自动触发，界面不需要（也无法）催它，
   * 带 false 调进来会被拒（不能让一个看着像"保存"的按钮偷偷跳过冲突检测）。
   */
  'sftp:editSave': { args: [{ editId: EditId; force?: boolean }]; result: RemoteEditEntry }
  /**
   * 重试上一次没写成的存盘：把 main 侧留着的 pending 再走一遍**带冲突检测**的写回。
   * 与 editSave 刻意分成两个 channel 而不是加个 intent 参数 —— 一个跳过冲突检测、
   * 一个不跳，混在同一个 channel 里迟早会有人把默认值填错。error 态的默认出口是这条：
   * 那些"会话未就绪"之类的瞬时故障，不该把用户推上无条件覆盖别人改动的路。
   */
  'sftp:editRetry': { args: [{ editId: EditId }]; result: RemoteEditEntry }
  /** 停止编辑：关监视、删本地临时目录；远端不动 */
  'sftp:editStop': { args: [{ editId: EditId }]; result: void }
  /**
   * 选"编辑远端文件用的编辑器"：**对话框与校验全在 main 侧**，选中后由 main 自己写进设置，
   * 返回选中的绝对路径供界面回显；取消返回 null。
   *
   * 为什么不让渲染进程自己 settings:set：这个字段最终是 spawn 的**可执行文件**，
   * 渲染进程能写它就等于能执行本机任意程序（settings:set 会把它剥掉，见
   * MAIN_ONLY_SETTINGS_PATHS）。
   */
  'sftp:pickEditor': { args: []; result: string | null }
  /** 清空 externalEditorPath（回到"系统默认打开"）。同样只能由 main 侧写 */
  'sftp:clearEditor': { args: []; result: void }

  // --- 传输队列 ---
  'transfer:enqueue': { args: [TransferEnqueueItem[]]; result: TaskId[] }
  'transfer:control': {
    args: [{ taskId: TaskId; op: 'pause' | 'resume' | 'cancel' | 'retry' }]
    result: void
  }
  'transfer:clearFinished': { args: []; result: void }
  'transfer:list': { args: []; result: TransferTask[] }

  // --- 监控 ---
  'monitor:start': { args: [{ sessionId: SessionId; intervalMs?: number }]; result: MonitorStaticInfo | null }
  'monitor:stop': { args: [SessionId]; result: void }
  'monitor:setInterval': { args: [{ sessionId: SessionId; intervalMs: number }]; result: void }

  // --- 端口转发 ---
  'forward:list': { args: [ProfileId | null]; result: Array<ForwardRule & { runtime?: ForwardRuntime }> }
  'forward:save': { args: [ForwardRule]; result: void }
  'forward:delete': { args: [ForwardId]; result: void }
  'forward:control': { args: [{ forwardId: ForwardId; sessionId: SessionId; op: 'start' | 'stop' }]; result: void }

  // --- 快捷命令 ---
  'snippet:list': { args: []; result: { groups: SnippetGroup[]; snippets: Snippet[] } }
  'snippet:save': { args: [Snippet]; result: void }
  'snippet:delete': { args: [string]; result: void }
  'snippetGroup:save': { args: [SnippetGroup]; result: void }
  'snippetGroup:delete': { args: [string]; result: void }
}

// ---------------------------------------------------------------------------
// ② renderer → main，高频单向
// ---------------------------------------------------------------------------
export interface SendMap {
  /** 键盘输入（含粘贴） */
  'term:input': { termId: TermId; data: string }
  /** 终端下行背压确认：renderer 已消费 bytes 字节（见计划 4.2） */
  'term:flow-ack': { termId: TermId; bytes: number }
}

// ---------------------------------------------------------------------------
// ③ main → renderer 事件
// ---------------------------------------------------------------------------
export interface EventMap {
  'session:state': { sessionId: SessionId; state: SessionState; error?: string }
  /** 认证/信任交互请求（应答走 invoke session:promptReply） */
  'session:prompt': SessionPrompt
  /** 终端下行数据批量帧（Uint8Array 结构化克隆） */
  'term:data': { termId: TermId; data: Uint8Array }
  'term:exit': { termId: TermId; reason: 'closed' | 'reconnected' | 'error' }
  /** 200ms 节流 */
  'transfer:progress': { taskId: TaskId; transferred: number; total: number; speedBps: number }
  'transfer:state': { task: TransferTask }
  /**
   * 远端编辑的状态流转。刻意只带"刷一行"所需的字段，完整快照走 sftp:editList ——
   * 一个 20KB 的 conf 每存一次盘要发两三条事件，没必要每条都把整个条目搬一遍。
   *
   * main 侧的 message 在这里按状态拆成 error / warning 两个字段：界面对这两者的呈现
   * 完全不同（拦下来等裁决 vs. 状态栏一行小字），拆在这里比让每个订阅方各自
   * 按 state 判断一遍靠谱。eolWarning 保持成码而不是文案 —— 那是要进 t() 的。
   */
  'sftp:editState': {
    editId: EditId
    sessionId: SessionId
    remotePath: string
    state: RemoteEditState
    /** conflict / blocked / error 的中文原因 */
    error?: string
    /** 存上了但有话说（例如权限位没能恢复） */
    warning?: string
    eolWarning?: EolWarning
  }
  'monitor:data': { sessionId: SessionId; snapshot: MonitorSnapshot }
  'monitor:state': { sessionId: SessionId; state: MonitorState; error?: string }
  'forward:state': { runtime: ForwardRuntime }
  'settings:changed': AppSettings
}

// ---------------------------------------------------------------------------
// channel 名前缀白名单（preload 校验用）
// ---------------------------------------------------------------------------
export const CHANNEL_PREFIXES = [
  'app:',
  'settings:',
  'vault:',
  'conn:',
  'group:',
  'session:',
  'term:',
  'sftp:',
  'transfer:',
  'monitor:',
  'forward:',
  'snippet:',
  'snippetGroup:'
] as const

/**
 * settings:set 上**只许 main 自己写**的字段（`区段.键` 形式）。
 * IPC 边界收到渲染进程带上这些键时一律剥掉（不报错 —— 设置页保存会把整份 settings 原样带上）。
 *
 * 为什么这张表放在契约文件里而不是 settings.ipc.ts：它描述的是 settings:set 这个 channel
 * 的参数边界，和 CHANNEL_PREFIXES 是同一类东西；放这儿也让护栏能直接 import 它去核对
 * "路径是不是真指向一个存在的设置字段" —— 字段改了名而这张表没跟着改，剥离就成了空转，
 * 洞会一声不响地重新打开。
 *
 * 现在表里唯一那条 sftp.externalEditorPath 是有实证的提权链：渲染进程能任意下载文件到
 * 本地任意路径（下载功能的固有设计），再把这个字段指向刚落地的 exe，下一次"编辑远端文件"
 * 就把它执行了 —— 全程无需用户交互。它只能由 sftp:pickEditor 在 main 侧校验后写入。
 */
export const MAIN_ONLY_SETTINGS_PATHS = ['sftp.externalEditorPath'] as const

export type InvokeChannel = keyof InvokeMap
export type SendChannel = keyof SendMap
export type EventChannel = keyof EventMap

/** preload 暴露到 window.ofs 的 API 形状（renderer 侧通过 src/preload/index.d.ts 获得全局声明） */
export interface OfsApi {
  invoke<K extends InvokeChannel>(channel: K, ...args: InvokeMap[K]['args']): Promise<InvokeMap[K]['result']>
  send<K extends SendChannel>(channel: K, payload: SendMap[K]): void
  /** 返回取消订阅函数 */
  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void
  /**
   * 拖拽上传用：取 File 对象对应的本地绝对路径。
   * Electron ≥32 起 File.path 被移除，必须经 webUtils（只能在 preload 侧调用）。
   */
  getPathForFile(file: File): string
}
