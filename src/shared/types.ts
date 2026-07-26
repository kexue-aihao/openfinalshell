/**
 * 三层（main/preload/renderer）共享的领域类型。
 * 本文件禁止任何运行时依赖 —— 只允许 type/interface/const 字面量。
 */

// ---------- ID 体系 ----------
export type ProfileId = string // 连接配置（持久化）
export type GroupId = string
export type SessionId = string // 一次运行期连接实例（同一 profile 可开多个）
export type TermId = string // 一个 shell channel = 一个终端 tab
export type TaskId = string // 一个传输任务
export type ForwardId = string // 一条转发规则
export type SnippetId = string
export type SecretRef = string // Vault 凭据引用，renderer 永远拿不到明文

// ---------- 连接配置 ----------
export type AuthMethod = 'password' | 'privateKey' | 'agent'

export interface ConnectionAuth {
  method: AuthMethod
  /** Vault 引用；无值且 method=password 时连接前向用户索要一次性密码 */
  passwordRef?: SecretRef
  /** 私钥一律引用外部文件，不内嵌 */
  privateKeyPath?: string
  /** 私钥口令的 Vault 引用 */
  passphraseRef?: SecretRef
}

// ---------- 代理（拨号侧） ----------
/** 'none' 即直连；http 走 CONNECT 隧道，socks5 走 RFC1928 */
export type ProxyType = 'none' | 'http' | 'socks5'

export interface ConnectionProxy {
  type: ProxyType
  host: string
  port: number
  /** 需要认证时填；HTTP 用 Basic，SOCKS5 用 RFC1929 */
  username?: string
  /** 代理密码的 Vault 引用，renderer 永远拿不到明文 */
  passwordRef?: SecretRef
}

export interface ConnectionProfile {
  id: ProfileId
  name: string
  groupId: GroupId | null
  /** 标签颜色（8 色预置之一），用于树节点与 tab 色点 */
  color?: string
  host: string
  port: number
  username: string
  auth: ConnectionAuth
  terminal: {
    /** 'utf-8' 默认；'gbk' 等经 iconv-lite 双向转码 */
    charset: string
    termType: string
    /** 登录后自动执行的命令 */
    startupCommand?: string
  }
  options: {
    keepaliveInterval: number
    readyTimeout: number
    /** 向算法表追加 ssh-rsa/dh-group14-sha1/aes128-cbc 等老算法 */
    legacyAlgorithms: boolean
    autoReconnect: boolean
    monitorEnabled: boolean
    compress: boolean
  }
  /** 经 HTTP/SOCKS5 代理拨号；无值或 type='none' 为直连 */
  proxy?: ConnectionProxy
  /** 预留（v1.5 跳板机），v1 不做 UI */
  jumpHostId?: ProfileId
  note?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

/** renderer 提交的连接草稿：密码/口令为明文，main 转 Vault 引用后落盘 */
export interface ProfileDraft
  extends Omit<ConnectionProfile, 'id' | 'auth' | 'proxy' | 'createdAt' | 'updatedAt'> {
  id?: ProfileId
  auth: {
    method: AuthMethod
    /** 明文，仅在保存表单时单向传给 main；undefined = 保持原值 */
    password?: string
    privateKeyPath?: string
    passphrase?: string
    /** true 时清除已存密码/口令 */
    clearPassword?: boolean
  }
  proxy?: Omit<ConnectionProxy, 'passwordRef'> & {
    /** 明文，同上；undefined = 保持原值 */
    password?: string
  }
}

export interface ConnectionGroup {
  id: GroupId
  name: string
  parentId: GroupId | null
  order: number
}

// ---------- 会话 ----------
export type SessionState = 'connecting' | 'authenticating' | 'ready' | 'reconnecting' | 'closed'

/** 认证/信任交互（hostkey 确认、keyboard-interactive、临时密码）统一走该请求-应答协议 */
export type SessionPromptKind = 'hostkey-new' | 'hostkey-changed' | 'kbi' | 'password'

export interface HostkeyPromptPayload {
  host: string
  port: number
  keyType: string
  fingerprintSha256: string
  /** hostkey-changed 时的旧指纹 */
  previousFingerprint?: string
}

export interface KbiPromptPayload {
  title: string
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
}

export interface PasswordPromptPayload {
  username: string
  host: string
}

export interface SessionPrompt {
  requestId: string
  sessionId: SessionId
  kind: SessionPromptKind
  payload: HostkeyPromptPayload | KbiPromptPayload | PasswordPromptPayload
}

export interface SessionPromptReply {
  requestId: string
  ok: boolean
  /** kbi 的应答数组 / password 的一次性密码（单元素） */
  answers?: string[]
  /** hostkey：永久信任；password：保存到 Vault */
  remember?: boolean
}

// ---------- SFTP ----------
export type RemoteFileType = 'file' | 'dir' | 'symlink' | 'other'

export interface SftpEntry {
  name: string
  path: string
  type: RemoteFileType
  /** symlink 时 follow stat 的结果：指向目录则可双击进入 */
  targetType?: RemoteFileType
  size: number
  mode: number
  modeStr: string
  owner: string
  group: string
  mtime: number
  /** 文件名含 U+FFFD（非 UTF-8 编码），标黄禁操作 */
  badName?: boolean
}

export type TransferState = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'canceled'

export interface TransferTask {
  id: TaskId
  sessionId: SessionId
  kind: 'upload' | 'download'
  localPath: string
  remotePath: string
  /** 目录任务为 -1 */
  size: number
  transferred: number
  state: TransferState
  speedBps: number
  error?: string
  /** 目录任务的子文件任务 */
  parentId?: TaskId
  createdAt: number
  /** 这条任务走的是打包传输 */
  packed?: boolean
  /**
   * 打包传输的阶段。有它时界面显示阶段名代替状态名。
   *
   * 打包/解包期间进度**真的未知**：远端 tar 不吐进度，本地 tar 也不吐。
   * 所以那两个阶段进度条停在上次的百分比，由阶段名承载"它在动"这个信息 ——
   * **不许编百分比**。
   */
  phase?: TransferPhase
  /** 一行弱化说明：降级原因、tar 报的警告之类。不是错误，不该标红 */
  notice?: string
}

export type TransferPhase = 'scanning' | 'packing' | 'transferring' | 'extracting' | 'cleanup'

export interface TransferEnqueueItem {
  sessionId: SessionId
  kind: 'upload' | 'download'
  localPath: string
  remotePath: string
}

export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename' | 'resume'

// ---------- 远端文件编辑（本机编辑器改远端文件） ----------
export type EditId = string

/**
 * downloading → editing → uploading → editing（存盘成功回到 editing）。
 * 岔路四条 —— conflict（远端被改）、blocked（服务器不支持原子替换）、
 * shrink（本地内容急剧变短，像是编辑器只写了一半，message 里带"从 X 变成 Y"的实数）、
 * error（其它失败），共同点是"本地内容还在、远端一个字节没动"，都停下来等用户裁决。
 * 其中 shrink 与 blocked/conflict 的交互形状完全同款：出口是"仍然覆盖"（sftp:editSave
 * 带 force）或"停止编辑"，界面照 blocked 那条路做即可。
 * closed 只作为事件出现（停止编辑时发一次），editList 不会再返回它。
 */
export type RemoteEditState =
  | 'downloading'
  | 'editing'
  | 'uploading'
  | 'conflict'
  | 'blocked'
  | 'shrink'
  | 'error'
  | 'closed'

/** 存盘把整个文件的行尾翻了面：只警告，不替用户改回去 */
export type EolWarning = 'lfToCrlf' | 'crlfToLf'

/**
 * 一条正在编辑的远端文件。字段与 main 侧 RemoteEditManager 的 RemoteEditInfo 逐一对齐
 * （靠结构类型天然兼容，不让 shared 反向 import main）。
 */
export interface RemoteEditEntry {
  id: EditId
  sessionId: SessionId
  /** 用户点开的那条路径（软链就是软链本身）：列表 key 与界面展示都用它 */
  remotePath: string
  /** 真正读写的路径：软链解析后的真身，与 remotePath 相同表示不是软链 */
  resolvedPath: string
  /**
   * 本地临时副本的绝对路径。**出得去、进不来** —— 界面可以显示它、可以"在文件夹中显示"，
   * 但没有任何 channel 接受本地路径回传（理由见 main/ipc/sftp.ipc.ts 顶部那段）。
   */
  localPath: string
  state: RemoteEditState
  /** main 侧给的中文说明：失败原因 / blocked 原因 / 存上了但权限没恢复的告警 */
  message?: string
  eolWarning?: EolWarning
  /** 最近一次已知的内容长度 */
  size: number
  savedAt?: number
  createdAt: number
}

// ---------- 监控 ----------
export interface MonitorStaticInfo {
  hostname: string
  kernel: string
  arch: string
  distro: string
  cpuCores: number
  ips: string[]
}

export interface MonitorSnapshot {
  ts: number
  uptimeSec: number
  cpu: { usagePct: number; perCore: number[]; loadAvg: [number, number, number] }
  mem: {
    totalKb: number
    availableKb: number
    usedKb: number
    swapTotalKb: number
    swapUsedKb: number
  }
  net: Array<{ iface: string; rxBps: number; txBps: number; rxTotalBytes: number; txTotalBytes: number }>
  /** 非 df tick 为 null（磁盘容量每 5 tick 采一次） */
  diskFs: Array<{ fs: string; mount: string; totalKb: number; usedKb: number; usePct: number }> | null
  diskIo: Array<{ dev: string; readBps: number; writeBps: number }>
  /** best-effort，解析失败则无 */
  topProcs?: Array<{ pid: number; name: string; cpuPct: number; memPct: number }>
  /**
   * 连接/套接字计数。每 tick 都采（读 /proc/net/sockstat 是 O(1)，与连接数无关）；
   * 文件缺失（非 Linux、极简容器）为 null。
   * 注意 udpInuse 是**已打开的 UDP 套接字**数 —— UDP 无连接，不该叫"连接数"。
   */
  conns: {
    socketsUsed: number
    tcpInuse: number
    tcpOrphan: number
    tcpTw: number
    udpInuse: number
  } | null
  /**
   * 按 TCP 状态的明细（ESTABLISHED / LISTEN / …）。sockstat 给不出这个，
   * 必须遍历 socket 表，所以只在 df 那一档低频 tick 采，且是 best-effort：
   * 缺文件/缺 awk/超时一律当"没这份明细"，不影响总数、更不许把面板打成 failed。
   */
  tcpStates?: Record<string, number>
}

export type MonitorState = 'running' | 'failed' | 'unsupported' | 'stopped'

// ---------- 端口转发 ----------
export type ForwardType = 'local' | 'remote' | 'dynamic'
export type ForwardState = 'stopped' | 'active' | 'error'

export interface ForwardRule {
  id: ForwardId
  profileId: ProfileId
  type: ForwardType
  label: string
  /** local/dynamic：本地监听 */
  bindAddr: string
  bindPort: number
  /** local/remote：目标；dynamic 无 */
  dstHost?: string
  dstPort?: number
  autoStart: boolean
}

export interface ForwardRuntime {
  forwardId: ForwardId
  state: ForwardState
  activeConns: number
  totalBytes: number
  error?: string
}

// ---------- 快捷命令 ----------
export interface SnippetGroup {
  id: string
  name: string
  order: number
}

export interface Snippet {
  id: SnippetId
  groupId: string
  name: string
  /** 支持 {{host}} {{user}} {{port}} 占位符 */
  command: string
  autoEnter: boolean
  order: number
}

// ---------- 应用设置 ----------
export type ThemeMode = 'dark' | 'light' | 'system'
export type SidebarView = 'connections' | 'snippets' | 'forwards' | 'transfers'

export interface AppSettings {
  version: 1
  language: 'zh-CN' | 'en-US'
  themeMode: ThemeMode
  /** 强调色（8 色预置之一） */
  accent: string
  uiZoom: number
  disableGpu: boolean
  confirmOnCloseTab: boolean
  restoreTabsOnLaunch: boolean
  terminal: {
    fontFamily: string
    fontSize: number
    lineHeight: number
    cursorStyle: 'bar' | 'block' | 'underline'
    cursorBlink: boolean
    scrollback: number
    copyOnSelect: boolean
    rightClick: 'paste' | 'menu'
    confirmMultilinePaste: boolean
    /** 'auto' = 跟随 UI 主题 */
    themeId: string
    webgl: boolean
  }
  sftp: {
    downloadDir: string
    maxConcurrentPerSession: number
    maxConcurrentGlobal: number
    conflictPolicy: ConflictPolicy
    showHiddenFiles: boolean
    doubleClickAction: 'download' | 'open'
    /** 会话连上后自动展开下方 SFTP 分屏 */
    autoOpenOnConnect: boolean
    /**
     * 编辑远端文件时调起的编辑器 exe 绝对路径；空串 = 交给系统默认打开方式。
     * 只收一个 exe 路径、**不收参数模板** —— main 侧 spawn 时 shell: false + 参数数组，
     * 从根上不给命令注入留缝（见 RemoteEditManager.launchEditor）。
     * 字段名与那边的宽松取值一字不差，改名会让编辑器静默退化成系统默认打开。
     */
    externalEditorPath: string
    /**
     * 右键菜单里是否提供「快速删除（rm 命令）」。默认开。
     * 关掉只是隐藏菜单项 —— main 侧的守卫（绝对路径、无 . / ..、非空路径段至少两级）
     * 与这个开关无关，它拦的是"路径本身不该被 rm -rf"，不是"用户不该看到这个菜单"。
     */
    fastDelete: boolean
    /**
     * 目录传输时先在远端打成一个 tar、传一个文件、再本地解包。默认关。
     *
     * 这是**建议性**的：main 侧会自己判断值不值得（文件数、远端有没有 tar/mktemp、
     * 空间够不够、冲突策略是否与 tar 的覆盖语义相容），付不起就静默退回逐文件，
     * 并在那条任务的 notice 里说明原因。
     */
    packedTransfer: boolean
  }
  monitor: {
    intervalMs: number
  }
  layout: {
    /** react-resizable-panels 百分比尺寸 */
    sidePanelSizePct: number
    sidePanelCollapsed: boolean
    activeSidebar: SidebarView
    monitorPanelSizePct: number
    monitorPanelCollapsed: boolean
    sftpPaneOpen: boolean
    sftpPaneHeightPct: number
  }
  window: {
    width: number
    height: number
    maximized: boolean
  }
}

export interface AppVersions {
  app: string
  electron: string
  node: string
  chrome: string
}

// ---------- 数据导入 / 导出 ----------
/** 导入时同 id 数据已存在的处理方式 */
export type ImportConflictPolicy = 'skip' | 'overwrite' | 'duplicate'

/** 勾选导入哪几部分（profiles 连带分组与密码一起） */
export interface ImportSelection {
  profiles: boolean
  snippets: boolean
  forwards: boolean
  knownHosts: boolean
  settings: boolean
}

export interface ImportPreview {
  /**
   * 一次性令牌。main 侧暂存已解析的文件内容，renderer 只拿令牌 ——
   * 这样 renderer 永远不需要（也不能）向 main 递一个任意文件路径。
   */
  token: string
  path: string
  appVersion: string
  exportedAt: number
  /** 文件里带加密的密码段：一起导入需要当初的导出口令 */
  includesSecrets: boolean
  counts: {
    profiles: number
    groups: number
    snippets: number
    forwards: number
    knownHosts: number
    settings: boolean
  }
  /** 结构校验没通过、会被跳过的条目数 */
  invalid: number
  /** 与本机现有连接 id 相同的条数 */
  conflicts: number
}

export interface ImportApplyOptions {
  token: string
  /** 解开文件里密码段的口令；不给则连接导入后需重填密码 */
  passphrase?: string
  conflict: ImportConflictPolicy
  include: ImportSelection
}

export interface ImportResult {
  profiles: number
  groups: number
  snippets: number
  forwards: number
  knownHosts: number
  secrets: number
  settingsApplied: boolean
  skipped: number
  invalid: number
  /** 需要让用户知道的额外情况（未覆盖的主机指纹、未导入的本机字段等） */
  notes: string[]
}

// ---------- known hosts ----------
export interface KnownHostEntry {
  keyType: string
  fingerprintSha256: string
  addedAt: number
}
