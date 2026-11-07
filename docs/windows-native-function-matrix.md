# Windows 原生功能等价矩阵

## 2026-11-04 完整对齐复审

当前权威逐流程清单为 [windows-native-parity-status.md](windows-native-parity-status.md)。以下历史表中的“通过”只表示当时列出的局部测试，**不表示与 Electron 0.30.34 功能等价**。本轮新增嵌套连接树、设置局部保存、代理兼容、同屏工作区、编辑器工具和监控仪表盘；完整四批仍在实施，原生版保持预览身份。

本轮隔离证据位于 `build/windows-native-acceptance/parity-batch1-20261104/`、`final-ui-qa19-20261105/` 和 `full-parity-20261106/lan-sync-results-x64-r3/`。Core 190 项、SSH 49 项、终端 probe、Renderer 16 项及 Electron SFTP 18 项已通过；qa19 UI 部分复验，qa20 已通过命令库多行编辑回显修复的实际复测。完整最终 UI 仍未验收；状态见 `parity-results.json` 与 `final-ui-qa19-20261105/ui-results.json`。中文 IME、OS DPI、高对比度、普通用户、其他架构、真实服务和最终安装包不能由这些测试替代。

2026-11-06 后续补记：Native Core 最新为 280 项合同通过，Native SSH 为 49 项，Electron LAN Sync 集成测试为 7 项，SFTP 上传 skip 已成为本地化可见的终态队列项，目录父项汇总跳过数；下载同名文件替换/目录合并已对齐 Electron worker。独立隔离发布、10 语言 i18n、TypeScript 和最新版 26 项 SSH/SFTP smoke 通过。两项修复都没有最终窗口 UI Automation 证据，不改变完整流程状态。

2026-11-06 设置与迁移续补：WinUI 设置新增 Electron 同款八色强调色选择，并将所选颜色应用到 Fluent Accent 资源；下载目录设置新增系统文件夹选择器；新增 FinalShell 专用目录扫描、SSH/分组预览、skip/duplicate 冲突选择和导入结果；原生工作区新增有效窗口尺寸与最大化状态的安全恢复；About 新增同源 Logo、GitHub/Releases 入口和本地发行说明；启动流程新增首次引导、版本更新说明和同版本静默判定。强调色持久化、并发局部更新、加密导出与非法值回退、窗口边界校验、FinalShell 扫描/事务导入、发行说明资源以及启动版本元数据纳入 Core 合同，Core 271 项通过，x64 Release 构建通过。窗口绑定仍失败，设置视觉交互、窗口恢复、About、FinalShell 和启动提示 UI 未做 UI 验收，不能标为完整等价。

2026-11-06 Electron 导出兼容续补：原生迁移读取器已同时支持 Electron v1（明文 `data`、可选 scrypt/AES-GCM `secrets`）和 v2（整包 scrypt/AES-GCM `enc`）。v1 无凭据文件不再强制输入口令；含凭据时只解密凭据块，之后继续使用原生事务、备份、类别筛选、引用改写和 DPAPI 重存；安全范围内的旧 scrypt 参数也可迁移。Core 兼容合同 293 项、Native SSH 49 项、Electron 迁移定向测试 45 项及 x64 隔离发布通过；窗口导入 UI 仍受本机进程启动/绑定策略阻断。

2026-11-06 默认交互语义续补：WinUI 设置与运行时均采用 Electron 的默认值（隐藏文件显示、双击下载、右键粘贴、选中复制），同时保留显式用户设置和非法值安全回退。Core 合同 296 项、Native SSH 49 项及 x64 隔离发布通过；实际控件和会话窗口仍待 UI 复验。

2026-11-06 终端搜索与会话保持续补：原生终端搜索加入区分大小写、正则表达式、同一行多命中、当前/总数计数和超时保护；活动栏、设置与 AI 覆盖层切换不再停用当前选中会话的工作区。Native Core 301 项、Native SSH 49 项、Renderer 1779 项和 x64 隔离发布通过；真实 Native 窗口 UI 仍待复验。

基准为 Electron 的共享 IPC/用户流程和 Windows 11 x64 原生实现。状态只描述本轮证据：`通过` 表示在当前 fixture/本机范围内有可复现证据；`部分通过` 表示主要路径通过但矩阵仍有缺口；`阻断` 表示外部环境不可用。最新 LAN Sync r3 窗口未运行，不将服务/协议证据外推为 UI 通过。

| 能力 | Electron 基线 | 原生实现 | 本轮状态 | 证据与剩余项 |
| --- | --- | --- | --- | --- |
| 导航、设置、主题 | 原生窗口入口、平台主题 | `MainWindow`, `PlatformEnvironment` | 通过 | Windows 11 Build 26300 x64；导航、设置、深色主题可运行。Windows 10/浅色/高对比度未测 |
| 连接编辑与持久化 | `conn:*` | `ConnectionListViewModel`, `ConnectionGroupViewModel`, `NativeStore` | 通过 | SSH/RDP、认证、Agent、代理、分组、跳板机、终端编码控件；配置 CAS 合同测试通过 |
| SSH Agent | `agent` 认证 | `NativeSshAgent` | 通过（协议） | `SSH_AUTH_SOCK`、Windows OpenSSH Agent 命名管道、Pageant 身份/签名帧通过；未连接外部真实 Agent |
| 单跳跳板机 | `jumpHostId` | `NativeSessionManager`, `SshConnection` | 通过（fixture） | 双 fixture 独立 host-key、终端和 SFTP；仅单跳，缺失/嵌套引用明确失败 |
| 终端编码 | `REMOTE_CHARSETS` | `TerminalCharsetCodec` | 通过（协议） | utf8、gb18030、gbk、big5、latin1 分块往返；真实远端 locale 未测 |
| 终端会话与输出背压 | xterm 交互 | `NativeTerminalCanvas`, libvterm | 部分通过 | x64 终端 1039×467，命令/Unicode 往返，标签切换保持输出；IME、Narrator、DPI、多屏未验收 |
| 终端输入与交互 | 粘贴、鼠标、搜索、选择、缩放 | libvterm C ABI + Win2D、`NativeTerminalSearch` | 部分通过 | native probe 覆盖 paste/mouse/alternate screen；搜索现支持大小写、正则、同一行多命中和当前/总数计数，合同通过；IME/视觉和完整 UIA 操作未覆盖 |
| 主机指纹与认证提示 | host-key/KBI 对话框 | `MainWindow.ConfirmHostAsync`, `PromptAsync` | 通过（fixture） | 首次指纹和 keyboard-interactive smoke 通过；真实交互矩阵未测 |
| SFTP 浏览 | `sftp:*` | `NativeSftpBrowser`, `SshConnection`, `NativeSftpSort` | 部分通过 | fixture 覆盖浏览/重命名；r17 补名称、大小、修改时间列排序及 UID/GID 显示，r18 同步表头/行横向偏移，Core 326、SSH 49、x64 publish 通过。Electron 显示属主/组名，Native 仍只有数字 UID/GID；表头点击、视觉、横向滚动和拖放 UI 尚未取得窗口验收证据 |
| 文件上传下载 | SFTP/拖放/目录打包/批量冲突裁决 | `NativeSftpBrowser`, `NativeTransferQueue`, `NativePackedTransfer`, `NativeUploadConflictPlanner` | 部分通过 | UI 上传/下载和协议字节一致；上传文件/目录选择与拖放共用批次 ask/overwrite/skip/rename 规划；skip 显示为本地化终态队列任务并保留零传输字节；下载批量同名文件替换/目录合并与 Electron worker 一致，fixture smoke 覆盖已有本地目标替换后的远端字节核对，并保留本地符号链接/类型保护；目录打包仍需 Linux/fixture UI 全流程验收，Explorer 冲突对话框和真实拖放仍待 UI 复验 |
| 下载目标选择 | 未配置 `downloadDir` 时单个/多个都选择目录 | `NativeSftpBrowser.DownloadAsync` | 已接入统一 FolderPicker 入口；用户界面仍待实测 | x64 Release `download-flow-20261106` 构建通过；UI 绑定失败，未操作/截图 |
| 设置：强调色、下载目录浏览 | Electron 8 色 Accent 与文件夹浏览 | `NativePreferencesPanel`, `MainWindow.ApplyAppearance` | 已接入八色 Accent 资源映射和 FolderPicker；UI 待验收 | Core 259 项通过；x64 Release `finalshell-import-20261106` 构建通过；新隔离程序启动被执行策略拒绝，未操作/截图 |
| 主窗口尺寸与最大化恢复 | `window.ts` / `instances/windowState.ts` 保存默认窗口 bounds | `NativeWindowBounds`, `MainWindow.WindowState` | 已接入原生工作区尺寸/最大化持久化；UI 重启恢复待实测 | Core 边界合同通过、x64 隔离发布通过；最终窗口绑定失败，无尺寸变更/重启 UI 证据 |
| 目录传输 | 父子进度、控制、重试 | `NativeTransferQueue` | 部分通过 | 目录分组汇总完成、失败、跳过项；2 MiB 慢速 fixture 的文件暂停/恢复、失败重试和字节一致性通过；本批 4 项 skip 状态合同和 Core 全量 252 项通过；长目录队列 UI 未测 |
| 传输失败与取消 | `transfer:*` | `NativeTransferQueue` | 通过（fixture） | 慢速 paused partial 可恢复；冲突失败后重试成功；取消清理与大小校验通过 |
| Scintilla/Lexilla 编辑器 | CodeMirror 主要能力 | `NativeRemoteEditor`, `NativeScintillaTextSurface` | 部分通过 | x64 原生 HWND 加载，props/UTF-8/LF，`Ctrl+S` 保存、冲突、脏关闭通过；多文档、完整语言/大文件性能待验收 |
| 编辑器安全 | CodeMirror 编码和冲突 | `NativeRemoteEditorService`, `NativeTextCodec` | 通过（合同） | 8 MiB 上限、二进制拒绝、BOM/EOL、基线冲突、显著缩小确认、原子保存 |
| 监控 | `monitor:*` | `NativeMonitorService`, `NativeMonitorPanel` | 通过（fixture/部分） | UI 显示逐核 CPU、磁盘容量/I/O、Top 进程、socket/TCP、延迟与错误状态；真实 Linux/权限/断线未测 |
| 端口流量 | `portTraffic:*` | `NativePortTrafficService` | 部分通过 | 解析器和页面已接入；真实 Linux `ss` 和生产负载未测 |
| Local 转发 | `forward:*` | `NativeForwardManager` | 通过（fixture/UI） | 19-byte 回显载荷实际传输，页面统计 38 B；停止后活动连接 0 |
| Remote 转发 | `forward:*` | `NativeForwardManager` | 通过（协议） | SSH 专项测试完成真实 TCP 回环、双向字节和停止清理；完整 UI 长时场景未测 |
| Dynamic/SOCKS5 转发 | 动态代理 | `NativeForwardManager` | 通过（协议） | SOCKS5 无认证协商、CONNECT、载荷字节和遥测通过 |
| RDP | `rdp:*` | `RdpWorkerClient`, `NativeRdpSurface` | 阻断 | 本机缺少 FreeRDP runtime DLL（`0xC0000135`）；真实 RDP/音频/拖放未验收，当前不宣称已支持 |
| AI | `ai:*` | `NativeAiService`, `NativeAiViewModel`, `NativeAiMessageView`, `NativeAiAnswer`, libvterm bracketed-paste state | 部分通过 | 已补 AI 总开关、Provider 清 Token/删除入口及跨 Electron/Native 加密迁移。Core 对凭据替换/清除/删除采用事务，保留共享 secret 引用并合并旧 `tokenRef` 配置。关闭开关时服务拒绝测试/发现/对话并禁用对应控件。Core 265 项、10 语言 i18n、typecheck、x64 隔离发布构建通过；UIA 窗口绑定连续失败，AI 页面交互/真实 Provider/终端填入仍待验收 |
| 命令库/历史 | `snippet:*`, `history:*` | `NativeCommandLibrary` | 部分通过 | CRUD、分组与排序已接入；qa20 实机复验多行命令重开保留两行，自动回车仍关闭；跨端共享、完整发送和历史流程未测。证据 `final-ui-qa19-20261105/21-qa20-multiline-fixed-*` |
| LAN Sync | `sync:*` | `NativeLanSyncService` | 部分通过 | 本机接收配对和加密交换、实际导入计数、settings 局部合并、known-host 保护和回执字段已对齐；Electron/Android 真实网络互操作及最终窗口 UI 未测 |
| FinalShell 专用导入 | Electron `finalshellScan` / `finalshellImport` | `NativeFinalShellImporter`, `MainWindow.FinalShellImport` | 已接入目录扫描、样本预览、冲突 skip/duplicate、层级保留和密码不可解提示；真实 FinalShell 数据和 UI 待验 | Core FinalShell 合同通过；x64 Release 构建通过；窗口 UI 未启动 |
| 多窗口 | 独立编辑器窗口 | `NativeInstanceCoordinator` | 部分通过 | 单实例写者选举和窗口聚焦通过；NativeEditorWindowHost 已接入跨会话文档标签、最多 10 个文档、断线保留草稿和逐文档关闭裁决；最新窗口仍需 UI Automation |
| 更新/安装 | `update:*` | `NativeUpdateService`, `NativeUpdateCoordinator` | 部分通过 | x64 已完成签名 feed 0.30.32→0.30.33 自动下载、静默覆盖安装、重启和数据保留；哈希/RSA/流式下载/重定向/损坏包合同通过。x86/ARM64 真机、真实 GitHub Release、Authenticode 和回滚未验收 |
| Electron 连接树上下文菜单 | React body portal；鼠标右键、方向键和 Enter/Space | `NativeConnectionTree` `MenuFlyout`；鼠标、菜单键和 Shift+F10 共用目标捕获 | 代码/构建通过，原生 UI 待验 | Electron 组件已覆盖连接/分组目标、边界、Escape/滚动/失焦/resize；Native 新增 AutomationName 与键盘入口，WinUI 定位、焦点和 100/125/150% DPI 仍需实机 UIA |
| Electron → WinUI 3 迁移入口 | Electron 设置/关于 | `NativePreviewPanel`, `NativePreviewUpgradeService` | 通过（本机 x64） | 加密导出、一次确认、GitHub 架构清单、重定向白名单、流式哈希、安装器启动、已安装启动和离线状态；原生首次导入入口已由 UIA 识别。x86/ARM64 真机及 Authenticode 未验收 |
| 辅助功能/适配 | 键盘、DPI、Narrator | WinUI + UIA | 部分通过 | 主要控件暴露 AutomationName/焦点的代码已接入；连接树菜单键与 Shift+F10 已实现但未在窗口实测；完整 Narrator、高对比度、DPI、多屏矩阵未测 |
| 未迁移页面 | 引导、捐赠等 | 设置覆盖层已新增 About 页面，显示原生版本、环境、更新检查、变更说明、GitHub 入口和 Electron 同源 Logo；About 内已加入 Electron 同源 8 张捐赠二维码及本地化说明；内置 104 个版本发行说明，无资源时回退到 Releases 页面；启动时按 Electron 语义显示首次引导或版本更新提示 | About/捐赠/更新/启动判定入口已接入；实际弹窗与完整引导仍待 UI 复验 | `startup-notice-20261106/app-x64-r1` x64 自包含构建通过；Logo 及 8/8 二维码资源已复制；Electron 同源图标已嵌入 PE；Core 271、typecheck、i18n 通过；窗口 UI 绑定失败，About 和启动提示未实机验收 |

## 2026-11-07 SFTP 交互续补

原生浏览器新增面包屑路径、返回/前进历史、拖放目标提示、文件双击下载的显式目标以及名称/类型/大小/修改时间/权限表头。`NativeSftpDropTarget` 与 `NativeSftpNavigationHistory` 合同覆盖文件行与目录行落点、空白处回退、会话未就绪、导航进行中、不安全路径、历史提交和新导航截断；Core 309 项、SSH 49 项、x64 隔离发布通过。由于隔离 Native 窗口仍未取得可信 UIA 句柄，本项状态保持“部分通过”，不能把代码和合同测试外推成拖放或历史按钮 UI 已验收。

## 2026-11-07 连接树键盘菜单续补

连接树新增 Windows 菜单键和 Shift+F10 打开当前选中节点菜单，鼠标与键盘入口共用捕获目标和动作分发，菜单项有 AutomationName。x64 隔离发布通过；实际定位、焦点、DPI 和高对比度尚无窗口证据，状态保持“UI 待验”。

## 后续验收顺序

1. 在真实 Linux 主机上复跑监控、端口流量、五种编码、local/remote/dynamic 转发和断线恢复。
2. 用 Windows Explorer 真实拖放完成文件/目录上传，并做慢速大目录暂停、恢复、重试和 UI 进度验证。
3. 完成 IME、Unicode 组合字符、Narrator、高对比度、DPI、多显示器及粘贴/鼠标/搜索/选择/缩放矩阵。
4. 补齐 FreeRDP runtime 与真实 RDP 服务验收；未通过前保持系统 Remote Desktop 降级。
5. 运行签名 GitHub Release 流水线，验证 x86/ARM64、Authenticode、真实在线升级和回滚；完成 Electron/Android LAN Sync 与 FinalShell 专用迁移验收。
6. 在 Windows 10 22H2、普通用户、x86 与 ARM64 真机复跑；这些结果不能由本轮 x64 管理员会话替代。

正式替换 Electron 前，所有 `部分通过`、`阻断` 和 `未开始` 项必须关闭。




2026-11-06 追加矩阵说明：普通 `cd` 与快捷命令 `cd` 的静态目标现在进入原生 SFTP 跟随队列；初始 SFTP 目录按 `realpath(.)` 解析到 home，与 Electron 默认起点一致。完整矩阵仍需隔离窗口 UI 复验。


2026-11-06 独立编辑器窗口续补：Electron 编辑器工作流对应的原生独立窗口已接入；同一会话同一路径复用文档，不同会话同路径隔离，最多 10 个文档。会话断开时草稿保留且禁用保存/重读；关标签、关窗口和退出主窗口均逐文档裁决。隔离 x64 发布成功；Core 273、SSH 49、typecheck、i18n 通过。Windows 执行策略拒绝自动启动本次隔离包，未创建原生窗口、未产生 UIA 或截图证据。

| 连接树键盘上下文菜单 | `ConnectionTreePanel` body menu 支持鼠标和键盘 | `NativeConnectionTree` 共用菜单目标捕获、Menu 键/Shift+F10、AutomationName | 代码/构建通过 | 需在隔离窗口验证菜单定位、焦点、Escape、DPI 和高对比度 |

| SFTP 右键上传 | Electron 空白处/目录行提供上传文件和上传目录 | NativeSftpBrowser 右键菜单增加两个入口，目录行解析目标目录，文件行回退当前目录 | 代码/构建通过，UI 待验收 | 需验证文件选择器、目录目标、冲突对话框和 DPI 下菜单定位 |

| SFTP 键盘上下文菜单 | Electron 文件表格支持鼠标和键盘上下文入口 | NativeSftpBrowser 共用目标/选择捕获、Menu 键/Shift+F10、AutomationName | 代码/构建通过，UI 待验收 | 需验证键盘焦点、菜单坐标、选择集和 DPI |

| 传输队列可读性 | Electron 显示路径、进度、字节、父子汇总 | WinUI ListView 显示 Summary、Source→Target、ProgressPercent、CompletedBytes/TotalBytes | 代码/构建通过，UI 待验收 | 需验证目录父子展开、暂停/恢复/重试按钮和长路径裁切 |

## 2026-11-07 全流程稳定性续补

活动栏新增主题切换入口，原生设置兼容 Electron 的 `system` 主题；启动资源缺失时使用安全回退；全局 ContentDialog 门控解决并发会话/传输/编辑器/RDP 提示冲突。`full-flow-20261107` 的 Native Core 310 项、Native SSH 49 项、TypeScript、本地化及 x64 发布均通过。隔离窗口 UI Automation 仍未运行，因此主题视觉、窗口响应式布局和对话框真实并发路径仍保持“待验收”。

AI 活动栏可见性已按 Electron 的 `aiAssistantEnabled` 开关对齐：关闭时隐藏会话入口，设置中的 Provider 管理仍保留。
