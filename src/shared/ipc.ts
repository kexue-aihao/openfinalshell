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
  ForwardId,
  ForwardRule,
  ForwardRuntime,
  GroupId,
  MonitorSnapshot,
  MonitorState,
  MonitorStaticInfo,
  ProfileDraft,
  ProfileId,
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
