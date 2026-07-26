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
}

export interface TransferEnqueueItem {
  sessionId: SessionId
  kind: 'upload' | 'download'
  localPath: string
  remotePath: string
}

export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename' | 'resume'

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
