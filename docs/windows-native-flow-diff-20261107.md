# Electron → WinUI 3 逐流程差异矩阵（2026-11-07）

基线为 Electron 0.30.34 与当前工作区 WinUI 3 原生实现。本文按用户流程记录五层证据：Electron 入口、Electron IPC/事件语义、Native Core、WinUI 入口、实际验收。`合同通过` 只表示服务或数据契约有可复现测试；`UI 待验收` 不等于界面等价。

## 工作台与连接

| 用户流程 | Electron 入口与语义 | Native Core / WinUI 对应 | 当前证据 | 剩余差异 |
| --- | --- | --- | --- | --- |
| 活动栏切换连接、命令、转发、传输 | `features/layout/ActivityBar` 切换上下文侧栏，保留会话 | `MainWindow.xaml` 活动栏；`ActivityItemClicked` / `ActivatePage` | x64 发布通过；隔离窗口 UIA 未运行 | 需要在窗口中确认切换不销毁会话、焦点顺序、窄窗口折叠 |
| 连接树搜索与嵌套分组 | `ConnectionTreePanel`；按名称/主机/用户过滤，分组可嵌套 | `NativeConnectionTree`、`NativeConnectionHierarchy`、`ConnectionGroupViewModel` | Core 分组/循环/缺失父级合同通过 | 搜索、展开状态、拖动归组、右键目标仍需 UIA |
| 快速连接与最近会话 | 工作台欢迎区输入 URI，记录最近使用 | `MainWindow.Workbench` `QuickConnectAsync` / `RecordSuccessfulConnection` | 代码入口存在；构建通过 | 需要确认 URI 错误提示、最近项点击和重启恢复 |
| 连接编辑与代理 | `conn:*`、`proxy:*`，代理 `follow/direct/custom` | `ConnectionListViewModel`、`NativeProxyResolver`、连接编辑对话框 | Native Core/SSH 合同通过 | UI 字段、旧 `saved` 值回读和保存后刷新待实测 |
| 连接/分组上下文菜单 | React body portal，目标在打开时捕获 | `NativeConnectionTree.ShowMenu` `MenuFlyout` | 组件逻辑已覆盖 | WinUI 菜单定位、键盘可达性、高 DPI 待实测 |

## 会话、终端与编辑器

| 用户流程 | Electron 入口与语义 | Native Core / WinUI 对应 | 当前证据 | 剩余差异 |
| --- | --- | --- | --- | --- |
| 打开/复用/关闭 SSH 会话 | `session:open/close/reconnect`，同一 profile 复用会话 | `NativeSessionManager`、`OpenProfileAsync`、`NativeSessionWorkspace` | SSH 49 项、终端 probe 通过 | UI 标签关闭确认、多会话切换和断线重连待实测 |
| 终端输入、IME、粘贴、右键菜单 | xterm 输入、终端右键按设置粘贴或菜单、多行粘贴确认 | `NativeTerminalCanvas` + WinUI `TextBox` TSF 输入；`NativeTerminalSearch` | native probe、Core 合同通过 | 中文 IME 组合、鼠标报告、缩放、读屏和视觉菜单待实测 |
| 终端搜索/历史/命令库 | `term:*`、`history:*`、`snippet:*` | `ShowTerminalSearchAsync`、`NativeCommandLibrary`、`CommandLibraryViewModel` | 搜索与命令多行重开有证据 | 完整发送目标、历史清理、键盘路径待实测 |
| SFTP 浏览与目录跟随 | `sftp:readdir/realpath`，目录优先、名称/大小/修改时间排序，属主/用户组、终端 `cd` 跟随，面包屑和历史 | `NativeSftpBrowser`、`NativeSftpNavigationHistory`、`NativeShellPathSync`、`NativeSftpSort` | Core 326 项、SSH 49 项、x64 r18 发布通过；排序合同覆盖目录优先、名称、降序大小和升序修改时间 | 原生表头现可点按排序并显示 UID/GID；表头和列表横向滚动同步。Electron 展示长名称中的用户名/组名，原生目前只有数字 ID，仍存在显示语义差异。面包屑、返回/前进、Explorer 拖放、列排序视觉和窄窗口横滚待 UI 实测 |
| 传输队列 | `transfer:*`，父子进度、暂停/恢复、冲突策略、全局暂停/取消、下载后打开目标位置、总览速度/ETA | `NativeTransferQueue`、`NativeTransferTotals`、`NativePackedTransfer`、`NativeUploadConflictPlanner`、WinUI 队列状态操作 | fixture 字节一致、暂停/恢复/重试通过；全局控制、取消确认、状态门控、下载目标位置和叶子任务总览已接入 | 大目录 UI 进度、真实拖放、打包流程及队列按钮/总览视觉待实测；r15 的 323 Core/49 SSH 合同不包含 r17 新增 SFTP 表格 UI，相关窗口未通过 UIA 观察 |
| 远程编辑器 | `editor:*`，多文档、冲突、脏关闭、独立窗口 | `NativeRemoteEditor`、`NativeEditorWindowHost`、`NativeRemoteEditorService` | 编码/BOM/EOL/冲突合同通过；x64 构建通过 | 多文档窗口、关闭裁决和断线草稿无本轮 UIA 证据 |

## 运维工具

| 用户流程 | Electron 入口与语义 | Native Core / WinUI 对应 | 当前证据 | 剩余差异 |
| --- | --- | --- | --- | --- |
| 监控与端口流量 | `monitor:*`、`portTraffic:*`，按会话启停并更新状态 | `NativeMonitorService`、`NativeMonitorPanel`、`NativePortTrafficPanel` | fixture/解析合同通过 | 真实 Linux、权限不足、断线重连和趋势视觉待验收 |
| Local/Remote/Dynamic 转发 | `forward:*`，运行时连接数、字节数、停止清理 | `NativeForwardManager`、`NativeForwardTelemetryCounter` | 三类协议 fixture 通过 | 长时 UI、规则编辑和会话归属待实测 |
| RDP | `rdp:*`，嵌入式 Worker、剪贴板、音频、文件 | `RdpWorkerClient`、`RdpSessionViewModel`、`NativeRdpSurface` | 本机缺 FreeRDP runtime，标记阻断 | 真实 Worker、RDP 服务、音频/拖放不能用模拟替代 |

## 设置、迁移、同步与 AI

| 用户流程 | Electron 入口与语义 | Native Core / WinUI 对应 | 当前证据 | 剩余差异 |
| --- | --- | --- | --- | --- |
| 设置与即时生效 | `settings:get/update`，局部合并并保留未知字段 | `NativeSettings.Update`、`NativePreferencesPanel`、`ApplyAppearance` | Core 局部更新、Accent、窗口边界合同通过 | 实际控件即时生效、DPI/主题和重启恢复待验收 |
| Electron 数据迁移 | `app:export*` / `app:import*`，加密包、类别筛选、预览、事务 | `ExportEnvelope`、`NativeImportSelection`、`ImportData`、`RefreshAfterPortableImport` | v1/v2 读取、类别默认和事务合同通过 | 原生空库首次入口、密码错误/重复导入 UI 未实测 |
| LAN Sync | `sync:*`，配对、发送、应用回执 | `NativeLanSync`、`NativeLanSyncViewModel` | 本机网络合同和回执计数通过 | Electron/Android 真实互操作及窗口 UI 待验收 |
| AI Provider/对话 | `ai:*`，发现模型、真实聊天连接测试、流式/非流式响应、取消、图片与终端上下文 | `NativeAiService`、`NativeAiViewModel`、`NativeAiMessageView`；原生面板提供响应模式选择 | Core 凭据、聊天连接探测、取消、图片限制和非流式 JSON 解析合同通过；流式与非流式均保留显式终端填入 | 真实 Provider、响应模式视觉、终端显式填入待验收 |
| 更新与关于 | `update:*`、`app:getStartupNotice`、原生升级入口 | `NativeUpdateService`、`NativeStartupNotice`、About/迁移面板 | x64 更新/发行说明构建通过 | 真实签名清单、安装器、启动提示 UI 待验收 |

## 证据分级与当前结论

- **服务/契约层**：当前 Native Core 321 项、Native SSH 49 项、Renderer 1779 通过 / 37 跳过、TypeScript 和 10 语言本地化检查通过；x64 self-contained 发布通过。
- **窗口层**：当前 `app-x64-r18` 的 UI Automation 未完成。隔离 WinUI 窗口已由用户启动并在窗口清单中出现，但 Computer Use 无法将返回的 HWND 绑定到同一个报告的应用 owner，状态读取报 `window id ... no longer belongs to ...; current owner is ...`。因此不能把工作台、SFTP、迁移、编辑器窗口、监控、转发和响应式布局标为 UI 已通过。
- **外部阻塞**：FreeRDP runtime、真实 Linux 监控/转发、真实 AI Provider、Android LAN Sync、其他架构、普通用户、高对比度、IME、多显示器和最终安装包仍须单独验收。

## 下一步执行顺序

1. 用户手动启动最新隔离包 `build/windows-native-acceptance/full-flow-20261107/app-x64-r18/OpenFinalShell.App.exe`，使用新的 `OFS_NATIVE_TEST_DATA_DIR`；先解决 Computer Use 对隔离 HWND 的 owner 校验失败，或更换得到真实窗口截图/UIA 树的可信验收入口。
2. 先复验活动栏、连接树、会话标签和 SFTP 面板，再复验迁移、设置、编辑器和监控/转发。
3. 每个流程同时保存 UIA 树、截图、窗口尺寸/缩放和结果 JSON；失败项回到对应 ViewModel/Core 修复。
4. 只有 Native Core、WinUI 入口、行为等价和 UI 证据均具备，矩阵才可标记为通过。

## 2026-11-07 全流程续补

- 原生活动栏新增与 Electron 对应的主题切换入口，保留设置中的完整主题选择；NativeSettings 现在接受 `system` 主题值，未知值仍回退到安全默认值。
- 原生启动主题资源改为可选加载：缺少平台主题字典时回退到另一套主题或 App.xaml 基础资源，不在 `MainWindow` 创建前崩溃。
- 原生所有 `ContentDialog` 通过共享异步门控串行显示，避免会话、传输、编辑器和 RDP 回调同时弹窗时触发 WinUI 的“Only a single ContentDialog can be open”异常。
- 新隔离 x64 构建：`build/windows-native-acceptance/full-flow-20261107/app-x64/`；结构化结果：`build/windows-native-acceptance/full-flow-20261107/results.json`。
- 验证：Native Core 310 项、Native SSH 49 项、TypeScript、10 语言本地化和 x64 self-contained 发布通过。Native UI Automation 仍为 `NOT_RUN`，因为当前桌面没有可绑定的隔离 Native 窗口；不得把这些静态/合同证据当作窗口交互验收。
- AI 活动入口现在遵循 Electron 的 opt-in 语义：`aiAssistantEnabled=false` 时隐藏活动栏入口，但设置中的 AI 配置仍可访问；开启后才显示会话入口和交互控件。
- 原生 AI 对话现在支持 Electron 对齐的流式/非流式响应模式；非流式请求使用 `stream:false` 并接受字符串或文本内容数组，服务层仍执行相同的输入、图片、取消和响应大小限制。

## 2026-11-07 代码续补记录

本轮在不改变 Electron IPC 或共享导出格式的前提下完成两项 WinUI 入口对齐：

- 连接树菜单统一鼠标右键、菜单键和 Shift+F10 路径；捕获当前连接/分组目标，菜单项提供 AutomationName。
- SFTP 右键菜单补齐上传文件/上传文件夹；空白处落当前目录，目录行落该目录，文件行回退当前目录；会话未就绪或导航中时禁用。

验证：WinUI Release 编译通过；Native Core 309 项、Native SSH 49 项、TypeScript 和本地化检查均通过；隔离 x64 发布分别位于 `build/windows-native-acceptance/connection-tree-keyboard-20261107/app-x64/` 和 `build/windows-native-acceptance/sftp-context-menu-20261107/app-x64/`。Native UI Automation 仍为 NOT RUN，因为桌面只发现安装版 Electron，隔离窗口启动被本机策略拒绝。

## 2026-11-07 SFTP 键盘菜单代码续补

本轮进一步对齐 SFTP 文件表格：`NativeSftpBrowser` 的鼠标右键、Windows 菜单键和 Shift+F10 共用菜单构建与目标选择，菜单项提供 UI Automation 名称。隔离 x64 包位于 `build/windows-native-acceptance/sftp-keyboard-menu-20261107/app-x64/`，结果见 `results.json`；Native UI Automation 仍为 NOT RUN。

## 2026-11-07 传输队列 UI 数据接线续补

原生传输列表已接入现有队列模型的进度和路径字段，隔离 x64 包位于 `build/windows-native-acceptance/transfer-queue-template-20261107/app-x64/`。该批只改变呈现，未改变 NativeTransferQueue 行为；真实队列操作和 UIA 仍待窗口复验。

## 2026-11-07 传输队列全局控制续补

对齐 Electron `transfer:controlAll` 行为，Native Core 新增按顶层任务执行的队列级控制，避免父子任务重复操作；WinUI 传输侧栏新增“全部暂停”和“全部取消”，取消会先显示可取消任务数并要求确认。按钮文案复用共享 `transfer.pauseAll`、`transfer.cancelAll` 和 `transfer.cancelAllConfirm` 本地化键，未新增 locale 键或 IPC。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core 合同 | PASS，321 项 | `dotnet run --project windows/OpenFinalShell.Core.Tests/OpenFinalShell.Core.Tests.csproj -c Release` |
| Native SSH 合同 | PASS，49 项 | `dotnet run --project windows/OpenFinalShell.NativeSsh.Tests/OpenFinalShell.NativeSsh.Tests.csproj -c Release` |
| TypeScript / 本地化 | PASS | `npm run typecheck`、`npm run check:i18n` |
| x64 self-contained 发布 | PASS | `build/windows-native-acceptance/full-flow-20261107/app-x64-r11/` |
| Native UI Automation | NOT RUN | 隔离窗口尚未启动/绑定；全局按钮、取消确认和真实队列状态仍待窗口验收 |

结构化结果：`build/windows-native-acceptance/full-flow-20261107/results-r11.json`。r13 已加入传输总览，r14/r15 加入周期刷新及溢出保护；最新结果为 `results-r15.json`，App DLL SHA-256 `4EDCE06837854F4DC61A5BE215A2D400A6EA43D4EBB84D481F070AA9BEF1E20D`，Core DLL SHA-256 `4A982F4D94323BEEF5EF17BAA1C6079CEFA07FF20DCBCB84C980DCE7BC1BCFAC`。UI 验收仍为 NOT RUN，不将合同测试或成功构建计为实际界面通过。

## 2026-11-07 传输队列状态门控与打开下载位置

WinUI 队列工具栏现在根据选中任务状态启用暂停、继续、重试、取消和清理；完成的下载任务若本地目标仍存在，可打开下载目录或在资源管理器中选中文件。仅打开下载任务的位置，不对已清理的上传暂存源或已删除目标触发系统文件管理器。该 UI 行为不改变 Electron IPC、队列数据模型或传输状态契约。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core / SSH 合同 | PASS，321 / 49 | r11 本轮源代码已验证，当前改动不涉及 Core/协议 |
| TypeScript / 本地化 | PASS | r11 已通过；当前 UI 改动复用现有 locale 键 |
| x64 self-contained 发布 | PASS | `build/windows-native-acceptance/full-flow-20261107/app-x64-r12/` |
| Native UI Automation | NOT RUN | 隔离窗口仍未启动/绑定；按钮门控及资源管理器行为待窗口实测 |

结构化结果：`build/windows-native-acceptance/full-flow-20261107/results-r12.json`。App DLL SHA-256 `86D9C98913AF1F96B6D76FD390CABBABF529F2FE388AB9C1FED74024D233F39F`，Core DLL SHA-256 `A8ECED622CCB89C1FF855FA391E4060BCCAC4DCBA28DFF6A6D516483ED4A36F8`。
