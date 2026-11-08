# WinUI3 工作区、编辑器与 SSH 监控联合改进计划

状态：代码已实施，自动化验证通过；仍待 Windows 界面截图验收。本轮修改限于 WinUI3 前端及必要的共享本地化资源，未提交、未发版。

Written against: `02f33f73b7018ded89e05f0ffb67418573e72c5f` (`fix(native): correct terminal cursor and copy-on-select`)

## 审查范围

- 产品：Windows WinUI3 原生应用。
- 表面：独立远程编辑器窗口、设置中的快捷键页、SSH 会话工作区/监控侧栏、连接编辑器和连接树。
- 证据：用户提供的编辑器与快捷键截图；当前工作区源代码；Electron 的监控和位置标记实现。
- 本计划仅围绕用户列出的界面和连接过程体验，不扩展到其他页面。

## 现状与证据链

- 独立编辑器窗口由 `windows/OpenFinalShell.App/NativeEditorWindowHost.cs` 创建，使用默认 `Window` 标题栏和主题化 TabView；主窗口在 `MainWindow.xaml.cs` 设置了应用 ICO，但独立编辑器窗口没有复用该图标。编辑器的 Scintilla HWND 在 `Controls/NativeScintillaTextSurface.cs` 初始化时还会设置浅色背景和行号栏背景，主题配置随后才应用。用户截图也显示深色编辑器周围仍有浅色窗口边缘。影响范围是编辑器窗口的标题栏、TabView 外沿和编辑区边界。
- 快捷键设置页在 `MainWindow.xaml` 的 `SettingsShortcutControls` 中目前只有一个按钮，点击后由 `MainWindow.Shortcuts.cs` 打开独立对话框；用户截图确认该页主体空白，列表没有直接展示。
- 原生监控由 `Controls/NativeMonitorPanel.cs` 和 `NativeMonitorDashboard.cs` 组成，当前有 CPU、内存、网络、趋势图、时延、磁盘、进程和连接信息；但各明细区默认展开，部分状态直接显示枚举文本，图表颜色固定为蓝/橙。Electron `src/renderer/src/features/monitor/MonitorPanel.tsx` 与 `MonitorPanel.module.css` 已有信息分组和卡片层级，可作为同一产品的呈现参照。此次是用户提出的监控可读性和专业呈现改进，不新增采集指标。
- `OpenProfileAsync` 在 `MainWindow.xaml.cs` 中等待 `sessionsManager.OpenAsync` 完成后才创建 SSH 会话 Tab；虽然 `NativeSessionManager` 会发出 Connecting/Ready/Failed 状态，当前界面在等待期间没有会话工作区承载连接进度。`CreateSessionTerminalTab` 创建工作区时也没有自动调用 `ToggleMonitor`。
- 原生连接编辑器已有 `flag` 文本输入，连接树读取该值后把它当普通文本前缀显示；`ConnectionProfile` 保留完整 JSON，编辑保存也从原数据深拷贝，因此已有字段可继续存储标记。Electron 的 `RegionMarker.tsx` 与 `ProfileEditDrawer.tsx` 使用地区代码、离线矢量国旗、局域网/地球标记，并在未手选时按私网地址自动显示 LAN。原生版可沿用同一 `flag` 字段和代码值，无需改存储协议。

## 设计决策

在 WinUI3 原生应用中，将编辑器、快捷键页和监控面板统一到现有浅色/深色工作区资源与已有产品内容层级；复用当前 SSH 状态、监控服务、配置字段和 Electron 已有位置标记语义。连接阶段显示被动的进度状态，连接完成后依据已有 `monitorEnabled` 配置打开监控面板。所有修改限于原生前端呈现与会话界面组织，不改 SSH 传输、远程命令、监控采集业务、存储结构或 Electron 前端。

## 复用

- 主题资源：`ShellBackgroundBrush`、`WorkspaceBackgroundBrush`、`CardStrokeColorDefaultBrush`；主窗口现有 `Assets/OpenFinalShell.ico` 和 `Assets/OpenFinalShell.png`。
- SSH 与监控：`NativeSessionManager.StateChanged`、`NativeSessionSnapshot`、`NativeSessionWorkspace.ToggleMonitor`、`NativeMonitorService`、`NativeMonitorDashboard`。
- 配置：连接配置已有 `flag` 与 `options.monitorEnabled`；保留现有默认值和关闭监控的用户选择。
- Electron 参照：`src/renderer/src/features/monitor/MonitorPanel.tsx`、`MonitorPanel.module.css`、`connections/RegionMarker.tsx`、`connections/ProfileEditDrawer.tsx`。
- 快捷键：现有 `NativeWorkbenchShortcut` 路由与 `MainWindow.Shortcuts.cs` 中的快捷键和说明。

## 实施步骤

1. **统一独立编辑器窗口外观**
   - 在 `NativeEditorWindowHost` 为窗口设置应用 ICO，并让窗口标题栏、TabView 与客户区边缘响应当前应用主题；暗色主题不再露出浅色边框，浅色主题继续使用现有 Shell/Workspace 资源。
   - 收敛窗口根节点和 TabView 周围多余的浅色留白；窗口左上角显示 OpenFinalShell 标识，同时保留系统窗口按钮、拖动区域和原有多标签行为。
   - 保留 Scintilla 内容、标签关闭、未保存标记、快捷键和文件读写流程，只处理主题初始化顺序，避免首次加载短暂出现与主题不一致的底色。

2. **快捷键页直接展示列表**
   - 将 `SettingsShortcutControls` 中的弹窗按钮替换为设置页内的快捷键说明列表，分组展示会话切换、终端、文件和覆盖层操作。
   - 复用当前实际注册的快捷键及本地化说明；移除“再点一次才看到快捷键”的中间步骤。条目较多时由设置页已有纵向滚动承载。
   - 不增加按键重映射功能，不改变现有快捷键行为。

3. **提高原生监控栏的信息层级与读数质量**
   - 重排为系统摘要、CPU/内存、网络、磁盘、时延/负载、进程和连接明细；主要指标突出当前值、单位与趋势，详细列表作为次级信息收起展示。
   - 统一数值字体、单位、卡片间距、图表图例和主题颜色；容量类指标采用清晰的占用比例表达，网络收发保持方向和颜色一致。
   - 将采集中、等待会话、暂不可用、失败等状态转换为本地化的用户可读状态，不直接展示内部枚举名；静态主机信息与指标卡片分层。
   - 只调整 `NativeMonitorPanel`/`NativeMonitorDashboard` 的展示和状态文案，继续使用现有 `MonitorSnapshot` 数据与采集间隔，不增加远程脚本或新指标。

4. **为 SSH 建立被动连接进度并自动打开监控侧栏**
   - 在开始 `OpenAsync` 前立即呈现目标机器名称/地址及不确定进度动画；动画本身不接收点击、不要求用户推进。状态随现有 Connecting、Ready、Failed 状态结束或转换。
   - 保留主机密钥确认、口令/交互式认证等现有必要对话框；连接错误继续走当前错误呈现，不吞掉错误或让加载状态永久挂起。
   - SSH 会话 Tab 创建且连接 Ready 后，如该连接现有 `options.monitorEnabled` 为 true，自动打开该会话的监控侧栏；设置为 false 时尊重用户选择。复用 `ToggleMonitor` 和既有采集服务，确保同一活动会话只运行一份采集器。
   - 断线重连仍显示状态反馈；Ready 后监控恢复，连接失败/关闭时停止采集，沿用当前生命周期规则。

5. **补齐原生版服务器位置标记**
   - 将连接编辑器已有的 `flag` 文本框替换为与 Electron 同一组地区代码的本地化选择器，含常用地区国旗、LAN 和地球选项；将选中结果继续保存为现有 `flag` 字段。
   - 连接树根据地区代码渲染离线矢量标记，不把 `CN` 等代码当作普通文字显示；系统 emoji 在 Windows 上可能显示为字母缩写，因此优先复用 Electron 中的 Twemoji 矢量图稿/数据并随应用本地打包，不依赖网络或新增第三方 UI 包。按对应许可保留所需署名。
   - 与 Electron 保持一致：显式选择优先；未选择时，私网地址自动显示 LAN 标记；公网上未设置标记时保持现有默认展示语义。未知代码安全回退，不破坏跨版本导入的连接配置。
   - 不新增数据字段、不做连接资料迁移；对既有任意 `flag` 字符串保留兼容处理。

## 范围与排除

- 包含：上述五项 WinUI3 前端工作及相关资源/本地化文案。
- 继承：现有主题、连接配置、会话状态、监控采集器、窗口生命周期和编辑器行为。
- 验证：连接树和连接编辑器、SSH 等待/成功/失败/重连状态、监控开关、独立编辑器窗口、快捷键设置页。
- 排除：Electron 改动；SSH/监控后端业务逻辑；远程采集命令和协议；新监控指标；数据库/JSON schema 变更；安装器、发版和 Git 推送。

## 验收与验证

- **编辑器窗口：** 左上角显示应用标识；暗色/浅色主题下标题栏、TabView、编辑区边缘一致，无截图所示浅色边缘；多标签、关闭、未保存标记和独立窗口主题切换正常。
- **快捷键页：** 打开快捷键设置即能看到完整分组列表；不弹额外对话框；文本与当前实际快捷键路由一致，窗口缩小时可纵向滚动浏览。
- **监控：** CPU、内存、网络、时延、负载、磁盘、进程及连接信息均以清晰单位显示；主要图表含明确图例；浅色/深色主题可读；加载、断连、错误和空数据状态清晰；采集频率与原有设置一致。
- **SSH：** 模拟慢连接可持续看到目标与被动加载指示；认证和主机密钥弹窗仍可正常交互；Ready 后加载态消失、终端可输入；失败时显示现有错误；启用监控的连接自动开监控，关闭该选项则不自动开。
- **位置标记：** 可编辑和保存国家/地区、LAN、地球选项；保存重启后连接树正确显示图形标记；空标记私网地址自动显示 LAN；导入旧连接与未知标记不会损坏或丢失配置。
- **系统检查：** `dotnet build windows/OpenFinalShell.App/OpenFinalShell.App.csproj -p:Platform=x64 --no-restore` 通过，0 警告、0 错误；核心契约检查通过 60 项；10 份本地化 JSON 和 18 个 SVG 资源均通过校验；`git diff --check` 通过。截图级验收尚未完成：当前自动化环境无法可靠绑定启动后的 WinUI 窗口，因此 100%/200% 缩放、浅色/深色及高对比度截图检查仍需在 Windows 原生验收环境执行。

## 停止条件

- 若现有 Windows 标题栏 API 无法在保留系统窗口控制和可拖动区域的情况下实现主题融合，应先保留原生窗口控制区，仅调整可控客户区，并在变更计划中记录差异。
- 若 Electron 的地区资源无法在原生项目中满足许可或打包条件，先暂停位置图稿移植并反馈替代方案，不退化为 Windows 旗帜文字缩写。
- 若监控指标的数据定义与 Electron 视图不一致，只调整既有原生数据的呈现，不改采集逻辑或隐式补造指标。

## 设计文档

- 实施验收后无需新增全局设计规范；沿用当前主题资源和产品既有 Electron 监控/位置标记范例。
