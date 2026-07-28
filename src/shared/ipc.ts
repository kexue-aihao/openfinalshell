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
  CommandHistoryEntry,
  ConnectionGroup,
  ConnectionProfile,
  FinalShellImportOptions,
  FinalShellImportResult,
  FinalShellScan,
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
  RemoteFileSaveResult,
  RemoteFileView,
  RemoteSaveGates,
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
import type { RemoteCharset } from './constants'

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
  /**
   * 选一个 FinalShell 数据目录并扫描，返回概要供用户确认；取消对话框返回 null。
   *
   * `dir` 只给测试与冒烟用（不弹对话框）。**渲染进程正常路径下不传** ——
   * 让渲染进程递任意路径进来，等于把"读哪个目录"的决定权交给了它。
   */
  'app:finalshellScan': { args: [{ dir?: string }]; result: FinalShellScan | null }
  /** 按 finalshellScan 给的 token 真正写入（密码走 Vault 加密，见 finalshellImport） */
  'app:finalshellImport': { args: [FinalShellImportOptions]; result: FinalShellImportResult }

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

  // --- 内置编辑器：查看与保存 ---
  /**
   * 读一个远端文本文件给内置编辑器看。**无副作用、不在远端留任何东西、没有状态。**
   *
   * `charset` 由渲染进程可控（状态栏能切），所以在 zod 那一层就按 REMOTE_CHARSETS
   * 白名单卡死 —— 理由见 shared/constants.ts 里那段（iconv 的 'hex' 能构造任意字节）。
   * 不传则按 utf8 读；解不干净时 `lossless: false`，界面据此提示用户换编码。
   */
  'sftp:fileView': {
    args: [{ sessionId: SessionId; path: string; charset?: RemoteCharset }]
    result: RemoteFileView
  }
  /**
   * 把编辑器缓冲区里的正文写回远端。与 `sftp:fileView` 成对，`path` 用**同一条**
   * 用户点开的路径（软链就是软链本身）—— 软链解析在 main 侧重做一遍，
   * 渲染进程从来不知道真身在哪，也不该知道。
   *
   * `charset` / `eol` / `hasBom` 三个都**必填、不给默认值**，因为每一个的默认值都会
   * 静默改写文件：漏了 charset 就把 GBK 的配置按 UTF-8 存回去（整个文件变乱码）、
   * 漏了 eol 就把 CRLF 文件整个翻面、漏了 hasBom 就替用户删掉 .bat / .ps1 的 BOM。
   * 三者原样来自那次 fileView 的返回，除非用户在状态栏上显式改过 —— 那是他的选择。
   *
   * `gates` 见 RemoteSaveGates。三个开关全部必填，理由写在那儿。
   *
   * **不做的事**：这条 channel 不接受本地路径、不接受 baseline、也没有"保存全部"。
   * 基线只在 main 侧（见 main/sftp/editBaselines.ts），批量保存留给渲染进程逐个调 ——
   * 一次 invoke 一个文件，失败与确认才能一对一地对应上。
   */
  'sftp:fileSave': {
    args: [
      {
        sessionId: SessionId
        path: string
        text: string
        charset: RemoteCharset
        eol: 'lf' | 'crlf'
        hasBom: boolean
        gates: RemoteSaveGates
      }
    ]
    result: RemoteFileSaveResult
  }

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

  // --- 命令历史 ---
  /** 最近用过的命令，按 lastUsedAt 倒序（上限 COMMAND_HISTORY_MAX_ROWS） */
  'history:list': { args: []; result: CommandHistoryEntry[] }
  /**
   * 记一条命令。**故意走 invoke 而不是 SendMap**：
   *
   * 它看着像热路径（每敲一次回车一条），但真实频率是**人手速**，一次 invoke 的代价
   * 完全付得起；而 SendMap 那条路按设计是不过 zod 的（见 registry.onSend 的注释），
   * 于是渲染进程的一个 bug 就能把任意长度的字符串写进库里。这条 channel 的入参
   * 恰好是"用户在生产服务器上敲的原话"，宁可让它慢一点也要过一遍长度与非空校验。
   */
  'history:push': { args: [{ command: string }]; result: void }
  /** 清空历史。不可逆，界面上有独立确认 */
  'history:clear': { args: []; result: void }

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
  'history:',
  'snippet:',
  'snippetGroup:'
] as const

/**
 * **只许 main 自己写**的设置字段（`区段.键` 形式）。**目前是空的。**
 *
 * 唯一那条 `sftp.externalEditorPath` 随外部编辑器一起删掉了，所以表空了。
 * 留着这张表与 `stripMainOnlyPaths` 那套机制，是因为它挡住的那个错**已经犯过一次**，
 * 而知识本身比当时那一条键值钱：
 *
 * - 外来数据有**两个**入口 —— `settings:set`（IPC 边界）与 `applyImport`（导入文件），
 *   而不是一个。上一版只有前者剥，后者整条绕过去：递给受害者一份"导出的配置"，
 *   里面写一个指向 payload.exe 的编辑器路径，用户点一次导入就中了。
 * - 剥离不能下沉进 `patchSettings`：main 自己写这些字段时走的也是它。
 *
 * ⚠️ 所以往这张表里加键的人要知道：**加一条就够了，两个入口自动都覆盖**；
 * 反过来，如果哪天有人想"就地判一下"而不是加进这张表，那就是在重犯那个错。
 * 表为空期间 `stripMainOnlyPaths` 是个恒等函数 —— 它不假装在防什么，
 * 下面那条护栏也只断言"机制还接在两个入口上"，不断言它剥掉了任何东西。
 */
export const MAIN_ONLY_SETTINGS_PATHS: readonly string[] = []

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
