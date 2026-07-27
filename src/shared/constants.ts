/** 三层共享常量。禁止运行时依赖。 */
import type { AppSettings } from './types'

export const APP_NAME = 'OpenFinalShell'

/** 8 色预置：连接标签色 & UI 强调色 */
export const PRESET_COLORS = [
  '#1677ff', // 蓝（默认强调色）
  '#13c2c2', // 青
  '#52c41a', // 绿
  '#faad14', // 黄
  '#fa8c16', // 橙
  '#f5222d', // 红
  '#eb2f96', // 粉
  '#722ed1' // 紫
] as const

/** 终端下行批处理与背压水位（计划 4.2） */
export const TERM_FLUSH_INTERVAL_MS = 8
export const TERM_FLUSH_MAX_BYTES = 256 * 1024
export const TERM_FLOW_PAUSE_BYTES = 2 * 1024 * 1024
export const TERM_FLOW_RESUME_BYTES = 512 * 1024

/** 传输进度节流 */
export const TRANSFER_PROGRESS_INTERVAL_MS = 200

/** 监控采集 */
export const MONITOR_DEFAULT_INTERVAL_MS = 2000
export const MONITOR_MIN_INTERVAL_MS = 1000
export const MONITOR_MAX_INTERVAL_MS = 10000
/** df 每 N tick 采一次 */
export const MONITOR_DF_EVERY_N_TICKS = 5
/** 帧超时：写入批次后超过该时长未见 END 即丢帧 */
export const MONITOR_FRAME_TIMEOUT_MS = 5000

/**
 * 编辑远端文件的单文件上限。**8MB，从 2MB 放宽而来，判据是量出来的。**
 *
 * 放在 shared 而不是留在 main 里：渲染进程也要知道这个数（在打开之前就能给出
 * "这个文件太大"的说明，而不是发一趟 IPC 再被拒），而两处各写一个数迟早会漂。
 *
 * ---
 *
 * 量了四条约束，**先说结论：绑住这个数的是渲染进程的内存，不是 CPU 也不是带宽。**
 *
 * **① main 侧那几道 O(n) 关卡 —— 不是瓶颈。** 同一台机器实测（毫秒）：
 *
 * | 档 | decode | lossless 往返 | encodeFidelity | sha256 | looksBinary | 打开合计 | 保存合计 |
 * |---|---|---|---|---|---|---|---|
 * | 2MB  | 16 | 11  | 12  | 5  | 0.3 | 32  | 21  |
 * | 8MB  | 28 | 51  | 52  | 16 | 0.7 | 96  | 92  |
 * | 32MB | 90 | 188 | 232 | 67 | 3   | 348 | 378 |
 *
 * 全线性，32MB 都在 0.4s 以内。（GBK 的 encodeFidelity 贵 3 倍：32MB 要 649ms，
 * 仍不构成约束。）
 *
 * **② 每次按键的代价 —— 曾经是瓶颈，已经修掉。** 脏标记原先每敲一个键做一次
 * `doc.toString()` 比较，那是 O(整个文档)：1MB 1.8ms、8MB 7.4ms、32MB **14.3ms**
 * （一帧就 16ms）。改成"先比 length，再 `Text.eq`"之后是 0.001ms
 * （见 CodeEditor.tsx 里 docBaseText 的注释）。**这一条是放宽上限的前置条件** ——
 * 不修的话 8MB 上每敲一个键就白扔掉半帧。
 *
 * **③ 渲染进程内存 —— 这是真正的天花板，也是取 8MB 而不是更大的唯一理由。**
 * 一份 8MB 的 UTF-8 中文文件约 610 万字符，而 JS 字符串是 UTF-16 → 约 12.5MB；
 * store 里那份 + CodeMirror 的 rope 各一份，单个文件常驻约 3 倍 ≈ 37MB。
 * 而 MAX_OPEN_VIEWS 是 10 —— **最坏情况 370MB**。16MB 那一档就是 740MB，不能接受。
 * （现实里不会有人同时开十个 8MB 的文件，但上限的意义就是兜住最坏情况。
 *   把它做成"所有打开文件的总字节预算"会更准，但那要改 open() 的契约与错误文案，
 *   不属于这一片。）
 *
 * **④ 传输耗时 —— 唯一没有实测新档位的一条，如实标注。**
 * test/integration/benchEditIo.test.ts 在真机上量到 2MB 写 1681ms / 读 2499ms
 * （并发窗口开启后）。线性外推 8MB 约 5–8 秒。那是一次"点了之后等一会儿"的等待，
 * 期间界面有转圈、应用不卡 —— 对一个显式的"打开这个 8MB 文件"动作可以接受，
 * 而且比现在的行为（直接拒绝、让你去下载）好。
 * ⚠️ **这一条是外推不是实测**：那个基准要 `OFS_TEST_*` 的真服务器。
 * 它的档位已经加到 8MB，下次在真机上跑就有真数了 —— 如果那时发现 8MB 明显超预期，
 * 该动的是这个常量，不是那张表。
 */
export const MAX_EDIT_BYTES = 8 * 1024 * 1024

/**
 * 远端文本文件允许的编码。**这是安全边界，不是"方便用户"的清单。**
 *
 * iconv-lite 除了真编码之外还接受 `hex` / `base64` / `binary` 这类**字节变换**——
 * 而编码名在内置编辑器里是渲染进程可控输入（状态栏上能切）。传 `hex` 就意味着
 * 渲染进程能用一串 "0a1b2c…" 精确构造任意字节写到远端文件里，
 * "我们只传字符串所以构造不出任意字节"这个论证会当场失效。
 *
 * 所以它放在 shared：**IPC 边界的 zod 校验、main 的解码、渲染进程的下拉框，
 * 三处认的必须是同一张表**。判定一律用"在这张表里"而不是 iconv.encodingExists。
 * 收得这么紧的另一半理由是 UTF-16 类根本进不来 —— 它们含 NUL，looksBinary 会先拒掉。
 */
export const REMOTE_CHARSETS = ['utf8', 'gb18030', 'gbk', 'big5', 'latin1'] as const
export type RemoteCharset = (typeof REMOTE_CHARSETS)[number]

/** 一次性远端命令（ExecRunner） */
export const EXEC_DEFAULT_TIMEOUT_MS = 30_000
/** stdout 上限，超过即截断（保留头部）。仍能拿到退出码，见 ExecRunner 里的尾窗 */
export const EXEC_MAX_OUTPUT_BYTES = 262_144

/**
 * 快速删除（rm -rf）。
 *
 * 超时给到 10 分钟：删一棵几十万文件的树在机械盘上真的能跑这么久，
 * 而这条命令一旦超时就是"删了一半、不知道删到哪"—— 宁可等。
 * 批量上限同时限条数与命令长度：一条 `rm` 的命令行要塞进 ARG_MAX，
 * 而两个 4096 字符的路径就已经 8000 出头了。
 */
/**
 * 打包传输。
 *
 * `PACK_MIN_FILES` 是**文件数**门槛而不是字节门槛：tar 修的是"每个文件 4–6 个串行 RTT"
 * 这件事（而 maxConcurrentPerSession 只有 2），不是带宽。所以 3 个 4GB 的 ISO 会正确地
 * 落到逐文件，而一千个小文件才是它的用武之地。
 *
 * 空间余量给 5% + 16MiB：`du -sk` 数的是**已分配块**，稀疏文件与硬链接都会让它偏，
 * 而 tar 头本身也要占地方。探测超时给到 20 秒 —— `find | wc -l` 与 `du -sk` 各走一遍树，
 * 大树上真的慢；超时就退回逐文件（fail-closed）。
 */
export const PACK_MIN_FILES = 8
export const PACK_FREE_MARGIN = 1.05
export const PACK_FREE_SLACK_KB = 16 * 1024
export const PACK_PROBE_TIMEOUT_MS = 20_000

export const FAST_DELETE_TIMEOUT_MS = 600_000
export const FAST_DELETE_BATCH = 64
export const FAST_DELETE_MAX_COMMAND_CHARS = 8000

export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"Maple Mono NF CN", "Cascadia Mono", Consolas, "Microsoft YaHei Mono", "Microsoft YaHei", monospace'

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  language: 'zh-CN',
  themeMode: 'dark',
  accent: PRESET_COLORS[0],
  uiZoom: 100,
  disableGpu: false,
  confirmOnCloseTab: true,
  restoreTabsOnLaunch: false,
  terminal: {
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 1.2,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 5000,
    copyOnSelect: true,
    rightClick: 'paste',
    confirmMultilinePaste: true,
    themeId: 'auto',
    webgl: true
  },
  sftp: {
    downloadDir: '',
    maxConcurrentPerSession: 2,
    maxConcurrentGlobal: 4,
    conflictPolicy: 'ask',
    // 改默认值对老用户不生效：这个键他们库里已经显式存着 false，
    // 而 DocStore 是 deepMerge(defaults, stored) —— stored 赢。
    // 靠 settings.ts 里那次一次性迁移补上。
    showHiddenFiles: true,
    doubleClickAction: 'download',
    autoOpenOnConnect: true,
    // 空串 = 系统默认打开方式。默认不预填任何路径：猜错了会静默起一个用户没想用的程序，
    // 而"没配"这条路（shell.openPath）在每个平台上都能工作
    // 默认**开**：普通删除同样不可恢复，这个只是更快 —— 默认关会让这个对标 FinalShell 的
    // 功能没人发现。安全预算花在"深度至少两级"的守卫和那个独立的确认框上，不花在藏起来
    fastDelete: true,
    // 默认**关**：它要在远端建临时文件、在本地起 tar 子进程，而收益只在"很多小文件"
    // 这一种场景上。先让愿意的人显式打开，攒够真机经验再考虑改默认
    packedTransfer: false
  },
  monitor: {
    intervalMs: MONITOR_DEFAULT_INTERVAL_MS
  },
  layout: {
    sidePanelSizePct: 18,
    sidePanelCollapsed: false,
    activeSidebar: 'connections',
    monitorPanelSizePct: 22,
    monitorPanelCollapsed: false,
    sftpPaneOpen: false,
    sftpPaneHeightPct: 40,
    editorPaneHeightPct: 40
  },
  window: {
    width: 1280,
    height: 800,
    maximized: false
  }
}
