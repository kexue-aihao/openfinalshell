/**
 * 三层（main/preload/renderer）共享的领域类型。
 * 本文件禁止任何运行时依赖 —— 只允许 type/interface/const 字面量。
 */

// 与 constants.ts 之间是一个**纯类型**的双向引用（那边 import type AppSettings）。
// verbatimModuleSyntax 下 `import type` 整句擦除，所以运行时没有环。
// 编码那张表必须住在 constants.ts：它是个值（zod 校验与下拉框都要遍历它），
// 而这里要的只是从它派生出来的联合类型 —— 两处各写一遍才是真的会漂。
import type { RemoteCharset } from './constants'

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

// ---------- 内置编辑器 ----------
/**
 * 打开一个远端文本文件的结果：读一次字节、解一次码，就这些。
 *
 * **没有 id、没有状态机、远端零副作用** —— 失败就是失败，重试就是再读一遍。
 * 上一版这里对照的是外部编辑器那条路的 RemoteEditEntry（8 个态、本地明文临时副本、
 * 文件监视），那整条路已经删掉。留这句话是因为它解释了为什么这个类型这么朴素：
 * 那 8 个态每一个都是为"本地那份文件被别人改了之后怎么写回去"存在的，
 * 而内容一直在渲染进程手里时，一个都不需要。
 */
export interface RemoteFileView {
  /** 用户点的那条路径（软链就是软链本身） */
  requestedPath: string
  /** 真正读的路径：软链解析后的真身。与 requestedPath 不同时界面要显示"→ 真身" */
  resolvedPath: string
  /** 行尾已归一成 LF 的正文（编辑器内部只见 LF，见 main/sftp/textCodec.ts） */
  text: string
  charset: RemoteCharset
  eol: 'lf' | 'crlf'
  hasBom: boolean
  /** 原文件混用 LF 与 CRLF：**保存会把行尾统一掉**，所以界面上要先告诉用户 */
  mixedEol: boolean
  /**
   * 这份字节能不能无损地"解码→编码"回原样。false = 用当前编码解不干净（非法字节序列）。
   * ⚠️ 它**不**回答"编码猜对了没有"，见 textCodec 里 DecodeResult.lossless 的说明。
   */
  lossless: boolean
  /** 远端文件的字节数（不是 text.length） */
  bytes: number
  /** 远端权限位。界面上显示它，让用户在改之前就知道"这个文件你未必写得动" */
  mode: number
}

/**
 * 保存时那三道"用户确认后可以越过"的闸门。**三个字段全部必填、没有默认值。**
 *
 * 每一个都对应一次"用户看过风险并且点了确认"，而可选字段配 `?? false` 是最容易被
 * 顺手写成 `?? true` 的地方 —— 所以调用方必须逐个写出来，评审时也就逐个看得见。
 * IPC 那侧的 zod 同样把三个都标成必填 boolean：一个 `.optional()` 就能让默认值
 * 悄悄替用户做决定，而默认值的方向恰好是"放行"。
 *
 * 为什么是三个开关而不是一个 `force`：老路（外部编辑器）把三件事挤成一个
 * `force: boolean`，于是用户点"仍然覆盖"（我接受远端改动被盖掉）顺带把
 * 非原子替换也放行了 —— 他同意的是前者，承担的是后者。
 */
export interface RemoteSaveGates {
  /** 跳过冲突检测：用户看过"远端在你编辑期间被改过"之后点了"仍然覆盖" */
  overwriteRemoteChanges: boolean
  /** 允许非原子替换：用户看过"这台服务器不支持原子替换"之后同意承担那个窗口 */
  allowNonAtomic: boolean
  /** 允许内容大幅缩短：用户看过"内容缩水了这么多"之后确认这就是他要的 */
  allowShrink: boolean
}

/**
 * 内置编辑器保存的结果。
 *
 * 三个非 `saved` 的分支各对应 RemoteSaveGates 的一个开关 —— 它们**不是错误**，
 * 是"这一次一个字节都没写，等你决定"。真正的错误（编码不可逆、超过字节上限、
 * 打开状态已失效）走 invoke 的异常，因为那些没有任何确认能让它变安全。
 *
 * ⚠️ **刻意不含 baseline**。冲突检测的基线（sha / size / mtime）只存在 main 侧的
 * 注册表里，一个字节都不下发给渲染进程：一旦它能被回传，渲染进程的任何 bug 都能构造出
 * "基线正好等于远端现状"，于是冲突检测永远说"没变过"、永远静默盖掉别人的改动。
 */
export type RemoteFileSaveResult =
  | {
      kind: 'saved'
      /** 真正写上去的字节数（编码后的，不是 text.length） */
      bytes: number
      mode: number
      /** 内容已就位但有次要问题（目前只有一种：权限位没能恢复） */
      warning?: string
    }
  | { kind: 'conflict'; reason: string }
  | { kind: 'nonAtomic' }
  | { kind: 'shrink'; remoteBytes: number; localBytes: number }

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

// ---------- 命令历史 ----------
/**
 * 一条在终端里执行过的命令。
 *
 * 命令原文本身就是主键（见 main/store/commandHistory.ts）—— 所以这里没有 id：
 * 同一条命令执行十次是**一条**记录（`useCount` +1、`lastUsedAt` 更新），
 * 而不是十条。历史列表最烦人的失效方式就是被 `ls` 刷满。
 */
export interface CommandHistoryEntry {
  command: string
  lastUsedAt: number
  useCount: number
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
    /**
     * 记录在终端里执行过的命令（命令历史）。
     *
     * 关掉只停止**新的**记录，不动已经记下的 —— 删除走「清空列表」那个显式动作。
     * 之所以给这个开关：历史里存的是用户敲进生产服务器的原话，而命令行上偶尔真的会带口令
     * （`mysql -pXXX`、`curl -u a:b`）。那份数据不导出、不上传，但让人能关掉是应有的。
     */
    saveCommandHistory: boolean
  }
  sftp: {
    downloadDir: string
    maxConcurrentPerSession: number
    maxConcurrentGlobal: number
    conflictPolicy: ConflictPolicy
    showHiddenFiles: boolean
    /**
     * 双击一个文件做什么。`'open'` = 在**内置编辑器**里打开。
     *
     * 上一版 `'open'` 指的是"用外部编辑器打开"（下载到本机临时目录、起一个 exe、
     * 挂文件监视盯存盘）。那条路整条删掉了，语义搬到内置编辑器上 ——
     * 用户的选择不变，兑现方式换了，而且是更安全的那个：远端零副作用、本机零文件。
     */
    doubleClickAction: 'download' | 'open'
    /** 会话连上后自动展开下方 SFTP 分屏 */
    autoOpenOnConnect: boolean
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
    /** 内置编辑器那一格的高度。它没有对应的"开关"—— 有文件打开就在，全关掉就没了 */
    editorPaneHeightPct: number
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

// ---------- 从 FinalShell 导入 ----------
/**
 * 扫描 FinalShell 数据目录的结果，给确认框看。
 *
 * ⚠️ **一个字节的密文都不下发。** 渲染进程只需要知道"有几条、长什么样、什么带不过来"，
 * 而密文留在 main 侧的暂存里 —— 与本项目自己的导入同一条规矩（见 ImportPreview.token）。
 */
export interface FinalShellScan {
  /** 一次性令牌：main 侧暂存已解析内容，渲染进程不接触路径也不接触密文 */
  token: string
  dir: string
  counts: {
    profiles: number
    groups: number
    /** 结构不完整、被跳过的条目 */
    invalid: number
    /** 不是 SSH 的条目（RDP/VNC 之类），本项目不支持 */
    notSsh: number
    /** 有密码但解不出来的条数 —— 导入后这些连接需要重新输入密码 */
    lockedPasswords: number
  }
  /** 前几条的可读摘要，让用户确认"扫对了目录" */
  samples: Array<{ name: string; host: string; port: number; username: string }>
  /** 需要让用户知道的情况（密码带不过来、代理/转发未解析…） */
  notes: string[]
}

/** 同一台主机已存在时怎么办。id 是新生成的，所以判重按"主机+端口+用户名" */
export type FinalShellConflictPolicy = 'skip' | 'duplicate'

export interface FinalShellImportOptions {
  token: string
  conflict: FinalShellConflictPolicy
}

export interface FinalShellImportResult {
  profiles: number
  groups: number
  skipped: number
  invalid: number
  /** 真正写进本机密钥库的密码条数（当前恒为 0，见 finalshellImport 里的说明） */
  secrets: number
  notes: string[]
}

// ---------- known hosts ----------
export interface KnownHostEntry {
  keyType: string
  fingerprintSha256: string
  addedAt: number
}
