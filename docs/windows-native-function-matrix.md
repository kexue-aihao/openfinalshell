# Windows 原生功能等价矩阵

基准为 Electron 的共享 IPC/用户流程和 Windows 11 x64 原生实现。状态只描述本轮证据：`通过` 表示在当前 fixture/本机范围内有可复现证据；`部分通过` 表示主要路径通过但矩阵仍有缺口；`阻断` 表示外部环境不可用。

| 能力 | Electron 基线 | 原生实现 | 本轮状态 | 证据与剩余项 |
| --- | --- | --- | --- | --- |
| 导航、设置、主题 | 原生窗口入口、平台主题 | `MainWindow`, `PlatformEnvironment` | 通过 | Windows 11 Build 26300 x64；导航、设置、深色主题可运行。Windows 10/浅色/高对比度未测 |
| 连接编辑与持久化 | `conn:*` | `ConnectionListViewModel`, `ConnectionGroupViewModel`, `NativeStore` | 通过 | SSH/RDP、认证、Agent、代理、分组、跳板机、终端编码控件；配置 CAS 合同测试通过 |
| SSH Agent | `agent` 认证 | `NativeSshAgent` | 通过（协议） | `SSH_AUTH_SOCK`、Windows OpenSSH Agent 命名管道、Pageant 身份/签名帧通过；未连接外部真实 Agent |
| 单跳跳板机 | `jumpHostId` | `NativeSessionManager`, `SshConnection` | 通过（fixture） | 双 fixture 独立 host-key、终端和 SFTP；仅单跳，缺失/嵌套引用明确失败 |
| 终端编码 | `REMOTE_CHARSETS` | `TerminalCharsetCodec` | 通过（协议） | utf8、gb18030、gbk、big5、latin1 分块往返；真实远端 locale 未测 |
| 终端会话与输出背压 | xterm 交互 | `NativeTerminalCanvas`, libvterm | 部分通过 | x64 终端 1039×467，命令/Unicode 往返，标签切换保持输出；IME、Narrator、DPI、多屏未验收 |
| 终端输入与交互 | 粘贴、鼠标、搜索、选择、缩放 | libvterm C ABI + Win2D | 部分通过 | native probe 覆盖 paste/mouse/alternate screen，命中测试代码已在；IME/视觉和完整 UIA 操作未覆盖 |
| 主机指纹与认证提示 | host-key/KBI 对话框 | `MainWindow.ConfirmHostAsync`, `PromptAsync` | 通过（fixture） | 首次指纹和 keyboard-interactive smoke 通过；真实交互矩阵未测 |
| SFTP 浏览 | `sftp:*` | `NativeSftpBrowser`, `SshConnection` | 通过（fixture） | 根目录、文件信息、刷新、REALPATH、精确 RENAME |
| 文件上传下载 | SFTP/拖放 | `NativeSftpBrowser`, `NativeTransferQueue` | 部分通过 | UI 上传/下载和协议字节一致；代码支持 Explorer 文件/目录拖放，真实 OLE 视觉验收仍为 BLOCKED |
| 目录传输 | 父子进度、控制、重试 | `NativeTransferQueue` | 部分通过 | 目录分组与汇总合同通过；2 MiB 慢速 fixture 的文件暂停/恢复、失败重试和字节一致性通过；长目录长时 UI 未测 |
| 传输失败与取消 | `transfer:*` | `NativeTransferQueue` | 通过（fixture） | 慢速 paused partial 可恢复；冲突失败后重试成功；取消清理与大小校验通过 |
| Scintilla/Lexilla 编辑器 | CodeMirror 主要能力 | `NativeRemoteEditor`, `NativeScintillaTextSurface` | 部分通过 | x64 原生 HWND 加载，props/UTF-8/LF，`Ctrl+S` 保存、冲突、脏关闭通过；多文档、完整语言/大文件性能待验收 |
| 编辑器安全 | CodeMirror 编码和冲突 | `NativeRemoteEditorService`, `NativeTextCodec` | 通过（合同） | 8 MiB 上限、二进制拒绝、BOM/EOL、基线冲突、显著缩小确认、原子保存 |
| 监控 | `monitor:*` | `NativeMonitorService`, `NativeMonitorPanel` | 通过（fixture/部分） | UI 显示逐核 CPU、磁盘容量/I/O、Top 进程、socket/TCP、延迟与错误状态；真实 Linux/权限/断线未测 |
| 端口流量 | `portTraffic:*` | `NativePortTrafficService` | 部分通过 | 解析器和页面已接入；真实 Linux `ss` 和生产负载未测 |
| Local 转发 | `forward:*` | `NativeForwardManager` | 通过（fixture/UI） | 19-byte 回显载荷实际传输，页面统计 38 B；停止后活动连接 0 |
| Remote 转发 | `forward:*` | `NativeForwardManager` | 通过（协议） | SSH 专项测试完成真实 TCP 回环、双向字节和停止清理；完整 UI 长时场景未测 |
| Dynamic/SOCKS5 转发 | 动态代理 | `NativeForwardManager` | 通过（协议） | SOCKS5 无认证协商、CONNECT、载荷字节和遥测通过 |
| RDP | `rdp:*` | `RdpWorkerClient`, `NativeRdpSurface` | 阻断 | 本机缺少 FreeRDP runtime DLL（`0xC0000135`）；真实 RDP/音频/拖放未验收，当前不宣称已支持 |
| AI | `ai:*` | `NativeAiService`, `NativeAiViewModel` | 部分通过 | 合同覆盖多模型、流式、多模态、限制和端点安全；真实 Provider 未测 |
| 命令库/历史 | `snippet:*`, `history:*` | `NativeCommandLibrary` | 部分通过 | 原生 CRUD、分组、排序、发送和会话历史；跨端共享回归未测 |
| LAN Sync | `sync:*` | `NativeLanSyncService` | 部分通过 | 本机接收配对和加密交换通过；Electron/Android 真实网络互操作未测 |
| FinalShell 迁移 | `app:finalshell*` | `ExportEnvelope`, `NativeStore` | 部分通过 | 通用导出预览/事务导入通过；FinalShell 专用扫描未完成 |
| 多窗口 | 独立编辑器窗口 | `NativeInstanceCoordinator` | 部分通过 | 单实例写者选举和窗口聚焦通过；独立编辑器协调未完成 |
| 更新/安装 | `update:*` | `NativeUpdateService`, `NativeUpdateCoordinator` | 部分通过 | x64 已完成签名 feed 0.30.32→0.30.33 自动下载、静默覆盖安装、重启和数据保留；哈希/RSA/流式下载/重定向/损坏包合同通过。x86/ARM64 真机、真实 GitHub Release、Authenticode 和回滚未验收 |
| 辅助功能/适配 | 键盘、DPI、Narrator | WinUI + UIA | 部分通过 | 主要控件暴露 AutomationName/焦点的代码已接入；完整 Narrator、高对比度、DPI、多屏矩阵未测 |
| 未迁移页面 | 引导、捐赠等 | 无 | 未开始 | 本轮不在运维闭环范围 |

## 后续验收顺序

1. 在真实 Linux 主机上复跑监控、端口流量、五种编码、local/remote/dynamic 转发和断线恢复。
2. 用 Windows Explorer 真实拖放完成文件/目录上传，并做慢速大目录暂停、恢复、重试和 UI 进度验证。
3. 完成 IME、Unicode 组合字符、Narrator、高对比度、DPI、多显示器及粘贴/鼠标/搜索/选择/缩放矩阵。
4. 补齐 FreeRDP runtime 与真实 RDP 服务验收；未通过前保持系统 Remote Desktop 降级。
5. 运行签名 GitHub Release 流水线，验证 x86/ARM64、Authenticode、真实在线升级和回滚；完成 Electron/Android LAN Sync 与 FinalShell 专用迁移验收。
6. 在 Windows 10 22H2、普通用户、x86 与 ARM64 真机复跑；这些结果不能由本轮 x64 管理员会话替代。

正式替换 Electron 前，所有 `部分通过`、`阻断` 和 `未开始` 项必须关闭。