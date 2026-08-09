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
  /**
   * 引用一条已保存的私钥（`SavedPrivateKey`）。v0.4 起私钥认证走这条。
   *
   * 路径与口令都归那条记录，所以换一次私钥文件位置只改一处，
   * 新增机器直接从下拉框里挑。
   */
  privateKeyId?: PrivateKeyId
  /**
   * @deprecated v0.4 迁移前的内联私钥路径。**只在迁移时读，之后不再写入。**
   * 留着字段（而不是从类型里删掉）是为了让迁移代码有类型可依，
   * 也为了"迁移写错了还能人工找回"—— 与 v0.1.0 那次 JSON 迁移保留 `.migrated` 文件同一条取舍。
   */
  privateKeyPath?: string
  /** @deprecated 同上：迁移后口令归 `SavedPrivateKey.passphraseRef` */
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

// ---------- 可复用的代理与私钥 ----------
export type ProxyId = string
export type PrivateKeyId = string

/**
 * 一条可被多台机器引用的代理。
 *
 * v0.3 及以前代理是**内联**在每条连接上的（`ConnectionProfile.proxy`），同一个
 * Clash 混合端口要在 20 台机器上各填一遍、改端口要改 20 遍。提成独立实体之后
 * 连接只存一个 `proxyId`。
 *
 * 没有 `'none'` 这个类型：**不用代理就是不引用**（`proxyId` 为空）。内联那版必须有
 * `'none'` 是因为字段本身总在，而独立实体里"存在即启用"。
 */
export interface SavedProxy {
  id: ProxyId
  /** 显示名。迁移出来的先叫 `host:port`，用户可改 */
  name: string
  type: Exclude<ProxyType, 'none'>
  host: string
  port: number
  username?: string
  /** 代理密码的 Vault 引用，renderer 永远拿不到明文 */
  passwordRef?: SecretRef
  createdAt: number
  updatedAt: number
}

/**
 * 一条可被多台机器引用的私钥。
 *
 * **只记路径，不存私钥内容** —— 与 `ConnectionAuth.privateKeyPath` 上那条
 * "私钥一律引用外部文件，不内嵌"的声明是同一个决定。代价是私钥文件被移动或删除后
 * 这条记录失效（连接时会明确报出是哪一条），换来的是私钥明文永不进本项目的库与导出文件。
 */
export interface SavedPrivateKey {
  id: PrivateKeyId
  /** 显示名。迁移出来的取文件名 */
  name: string
  path: string
  /** 私钥口令的 Vault 引用 */
  passphraseRef?: SecretRef
  note?: string
  createdAt: number
  updatedAt: number
}

/**
 * 两个实体的草稿类型走与 `ProfileDraft` 完全相同的规矩：
 * **明文口令只单向进 main**，`undefined` 或空串 = 保持原值，要清掉得显式 `clearSecret`。
 */
export interface SavedProxyDraft {
  id?: ProxyId
  name: string
  type: Exclude<ProxyType, 'none'>
  host: string
  port: number
  username?: string
  /** 明文，仅在保存表单时单向传给 main */
  password?: string
  /** true 时清除已存的代理密码 */
  clearSecret?: boolean
}

export interface SavedPrivateKeyDraft {
  id?: PrivateKeyId
  name: string
  path: string
  /** 明文，同上 */
  passphrase?: string
  clearSecret?: boolean
  note?: string
}

/**
 * 删除一条被引用的实体时的结果。
 *
 * **被引用不是错误**，所以不抛异常：它是"这一次没删，先去改那几条连接"。
 * 抛异常的话渲染进程只能拿到一句话，列不出到底是哪几台机器在用它。
 */
export type DeleteRefResult = { deleted: true } | { deleted: false; usedBy: string[] }

/** 连接的代理归属方式，语义见 ConnectionProfile.proxyMode */
export type ProxyMode = 'follow' | 'direct' | 'custom'

export interface ConnectionProfile {
  id: ProfileId
  name: string
  /**
   * 连接协议。缺省（老数据）= `'ssh'`。`'rdp'` 走系统远程桌面（生成 .rdp 交给 mstsc），
   * 此时 auth/terminal/proxy/options 那套 SSH 字段一概不用 —— 凭据由 Windows 自己接管。
   */
  protocol?: 'ssh' | 'rdp'
  groupId: GroupId | null
  /** 标签颜色（8 色预置之一），用于 tab 色点与树节点回退标记 */
  color?: string
  /**
   * 位置标记：国家/地区代码（如 'JP'/'US'）、`'lan'`（局域网）、`'globe'`（公网/其它）。
   * 连接树按它显示国旗/局域网图标；未设时，私网 IP 自动显示局域网标记，否则回退到 color 色点。
   * 由用户按服务器物理位置手选（不自动按 IP 查国家——离线且不外发 IP）。
   */
  flag?: string
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
  /**
   * 代理归属方式：
   * - `'follow'` 跟随全局默认代理（设置里的 `connection.defaultProxyId`）——**新建连接的默认**
   * - `'direct'` 强制直连，无视全局默认
   * - `'custom'` 用本连接自己的 `proxyId`
   *
   * 缺省（老数据、迁移前）时按 `proxyId ? 'custom' : 'direct'` 解释 ——
   * 这保证老连接行为**一字不变**：此前直连的不会因为有人配了全局默认就突然改走代理。
   * 只有此后新建的连接才带 `'follow'`，"全局默认对新建连接生效"正是这么落地的。
   */
  proxyMode?: ProxyMode
  /**
   * 引用一条已保存的代理（`SavedProxy`）拨号。仅在 `proxyMode === 'custom'` 时有意义；
   * 缺省语义（无 proxyMode）下无值 = 直连。
   */
  proxyId?: ProxyId
  /**
   * @deprecated v0.4 迁移前的内联代理。**只在迁移时读，之后不再写入。**
   * 理由与 `ConnectionAuth.privateKeyPath` 那条相同。
   */
  proxy?: ConnectionProxy
  /** 预留（v1.5 跳板机），v1 不做 UI */
  jumpHostId?: ProfileId
  note?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

/**
 * renderer 提交的连接草稿：密码为明文，main 转 Vault 引用后落盘。
 *
 * ⚠️ v0.4 起草稿里**没有内联代理与私钥路径**了 —— 那两样各归自己的实体，
 * 连接只提交 `proxyId` 与 `auth.privateKeyId`。所以这里把 `proxy` 也 Omit 掉：
 * 留着它就意味着"还有第二条写代理的路"，而那正是这次改造要消掉的东西。
 */
export interface ProfileDraft
  extends Omit<ConnectionProfile, 'id' | 'auth' | 'proxy' | 'createdAt' | 'updatedAt'> {
  id?: ProfileId
  auth: {
    method: AuthMethod
    /** 明文，仅在保存表单时单向传给 main；undefined = 保持原值 */
    password?: string
    /** 引用一条已保存的私钥 */
    privateKeyId?: PrivateKeyId
    /** true 时清除已存密码 */
    clearPassword?: boolean
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

/**
 * `'skipped'` 是终态，与 `'done'` 分开：done 的含义是"字节已经在服务器上了"。
 * 用 done 表示跳过，会让分组进度的"800/800 完成"在撒谎，也会让所有按终态推理的
 * 地方（updateActivity、watchTransfers）把跳过算成传完。
 */
export type TransferState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'done'
  | 'error'
  | 'canceled'
  | 'skipped'

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
  /**
   * 这是个目录（分组）任务。分组任务**不自己搬字节** —— 它的 transferred/size 是
   * 子孙的汇总，并且随展开推进而增长（诚实的：main 是渐进发现目录树的，
   * 所以那一行同时显示 childDone/childTotal，分子分母比百分比可信）。
   */
  isGroup?: true
  childTotal?: number
  /** 含 skipped —— 跳过是用户要的结果，算"完成"，但下面另记一笔 */
  childDone?: number
  childFailed?: number
  childSkipped?: number
  /** 展开时跳过的软链接数（分组行上是子树累计） */
  skippedLinks?: number
  /**
   * 这条任务当初裁决的冲突动作。**必须留在任务上**，不能在入队时用掉：
   * overwrite 要到达 worker（那句"冲突已在入队阶段裁决"靠它才第一次成真），
   * retry 要复用当初用户选的那个而不是重读可能已改的设置，子任务还要继承它。
   */
  onConflict?: TransferConflictAction
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
  /**
   * 目录任务展开出来的子任务指回父任务。**main 内部字段**：
   * `transfer:enqueue` 的 zod schema 里刻意**不声明**它（registry 用 `parsed.data`，
   * z.object 会把未声明的键剥掉），于是渲染进程物理上伪造不了一个 parentId ——
   * 伪造一个就能让界面上的分组树错乱。
   */
  parentId?: TaskId
  /** 这一批裁决过的冲突动作。缺省时 worker 按 settings.sftp.conflictPolicy 兜底 */
  onConflict?: TransferConflictAction
  /**
   * 入队前已探到远端同名、且用户选了跳过：直接落 skipped 终态，不开连接、不排队。
   * **main 内部字段**（同 parentId：zod 里不声明，渲染进程伪造不了 —— 伪造一个
   * 就能让文件被静默跳过）。
   */
  skipExisting?: boolean
}

export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename' | 'resume'

/**
 * **已裁决**的冲突动作。与 ConflictPolicy 刻意分开：后者含 `'ask'`（还没裁决）
 * 与 `'resume'`（历史遗留，界面里从来没有、逐文件路径零消费者），
 * 而这两个值一旦流到 worker，就意味着"谁也没决定"的分支要在写文件那一刻现场编答案。
 */
export type TransferConflictAction = 'overwrite' | 'skip' | 'rename'

/** 远端已存在的同名项（探测结果的一条） */
export interface RemoteConflict {
  name: string
  kind: RemoteFileType
  size: number
  /** 远端修改时间（毫秒）。0 表示服务器没给 */
  mtime: number
}

export interface ConflictProbeResult {
  conflicts: RemoteConflict[]
  /** 这一批一共探了多少条 */
  total: number
  /**
   * 探测本身跑通了没有。**false 时界面必须说"未能检查"，绝不能当成"没有冲突"** ——
   * 把一次失败的探测显示成"无冲突直接传"就是静默覆盖。
   */
  probed: boolean
}

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
  /**
   * 本机 ↔ 服务器的通道往返毫秒：采集帧写入到首见 BEGIN 哨兵回显的耗时。
   * 走的是既有 SSH 通道，不另开连接（反复 TCP 探 22 端口会刷 sshd 日志）。
   * 打点尚未发生（首帧之前）时缺失。
   */
  latencyMs?: number
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
  /**
   * 自动检查更新（启动后 10 秒一次，之后每 6 小时）。默认开。
   *
   * 关掉只停止**自动**检查，设置页里的「检查更新」按钮照旧可用。
   * 下载是自动的、**安装永远要用户点** —— 这个软件里跑着活的 SSH 会话，
   * 装更新必然要退出应用，那一下不能由软件替用户决定。
   */
  autoCheckUpdate: boolean
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
    /**
     * 终端里执行 `cd xxx` 后文件面板自动跳到该目录。默认开。
     * 跳转是 best-effort：目标读不到（cd 打错了、无权限）就原地不动、不报错 ——
     * 终端自己会把 cd 的错误打给用户，面板再弹一条是重复噪音。
     */
    followTerminalCd: boolean
  }
  monitor: {
    intervalMs: number
  }
  connection: {
    /**
     * 新建连接（proxyMode='follow'）默认走的代理 id；`null` = 默认直连。
     * 改这里会实时影响所有"跟随全局"的连接，不影响显式设了直连/指定代理的那些。
     */
    defaultProxyId: string | null
    /**
     * 连接树里对 IP / 主机名打码（只显示首尾片段，方便截图分享）。默认开。
     * 只影响显示标签；连接、复制 SSH 命令、搜索仍用完整 host。
     */
    maskHostInList: boolean
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

/**
 * 启动提示：由"上次启动记录的版本"与"当前版本"比对得出，用来决定开机弹哪种窗。
 * - `'fresh'`  从未记录过版本 → 全新安装，弹"功能/快捷键"引导
 * - `'update'` 版本变了 → 弹"更新了什么"（fromVersion→toVersion 之间的更新说明）
 * - `'none'`   版本没变 → 不弹
 */
export type StartupNoticeKind = 'fresh' | 'update' | 'none'
export interface StartupNotice {
  kind: StartupNoticeKind
  /** 仅 update：上次启动的版本 */
  fromVersion?: string
  /** 当前版本 */
  toVersion: string
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
    proxies: number
    privateKeys: number
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
  /** 可复用的代理与私钥（跟着 profiles 那个开关一起导入） */
  proxies: number
  privateKeys: number
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

// ---------- 自动更新 ----------
/**
 * 更新器的状态。`unsupported` 专门给**免安装版**：它的 resources 里也带着
 * `app-update.yml`（nsis 与 portable 共享同一个 win-unpacked），如果不拦住，
 * 免安装用户会被下载一个 NSIS 安装包并装到 `%LOCALAPPDATA%` —— 等于把他悄悄变成安装版。
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'none'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  /** 当前版本，界面一处显示 */
  current: string
  /** 新版本号（available / downloading / downloaded 时有） */
  version?: string
  /** 下载进度百分比 */
  percent?: number
  transferred?: number
  total?: number
  error?: string
}

/**
 * 安装前要告诉用户的代价。**装更新必然要退出应用**，而退出就断掉所有
 * 终端会话、传输任务与端口转发 —— 这是这个软件与普通桌面应用最大的不同，
 * 所以数字由 main 侧算（它才是这些东西的唯一持有者），不让渲染进程猜。
 */
export interface UpdateActivity {
  sessions: number
  transfers: number
  forwards: number
}

/** `update:install` 的结果：要么真的开始装，要么先回一份"会断掉什么"等用户确认 */
export type UpdateInstallResult =
  | { installing: true }
  | { needsConfirm: UpdateActivity }
  | { error: string }

// ---------- known hosts ----------
export interface KnownHostEntry {
  keyType: string
  fingerprintSha256: string
  addedAt: number
}

/** 「已信任主机」管理面板的行（known_hosts 表一行 + 从主键拆出的展示字段） */
export interface TrustedHostkey {
  /** 表主键 "host:port:keyType"，撤销信任时原样回传 */
  key: string
  host: string
  port: number
  keyType: string
  fingerprintSha256: string
  addedAt: number
}
