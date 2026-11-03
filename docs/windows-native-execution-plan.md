# WinUI 3 本机 Windows 11 验收与核心功能补齐计划

## 目标与基线

先在本机 Windows 11 上记录原生预览版的可复现验收结果，再补齐核心运维闭环功能，最后对集成后的 x64 版本进行独立复验。

当前基线：Windows 11 Pro Build 26300、x64；已有原生预览构建和 SSH/SFTP fixture。当前没有 CMake/CTest，SSH fixture 未监听。验收需使用独立临时数据目录和 SFTP 根目录。本轮记录当前管理员权限，不代表普通用户或其他架构验收。

保留工作区已有修改、未跟踪文件和预览产物。新构建、截图及日志写入 `build/windows-native-acceptance/`，不得通过清理或覆盖旧预览产物来准备测试。

## 阶段与分工

### 阶段 0：基线验收

主代理记录 Git 工作区状态、OS/SDK/显示环境和现有构建信息；独立验收代理只运行测试，不修改产品代码。覆盖 Native Core 合同测试、WinUI x64 Release 构建、终端 x64 probe、页面 UI Automation 和本机 SSH/SFTP smoke。测试应用使用隔离数据目录；若缺少测试目录入口，由主代理增加仅供测试启动的显式覆盖参数，保持默认目录不变。先保存基线日志及复现步骤，再开始功能实现。

### 阶段 1：领域实现

- **代理 A：SSH、会话与终端。** 支持 `SSH_AUTH_SOCK`、Windows OpenSSH Agent 命名管道和 Pageant；实现单跳跳板机并复用 `jumpHostId`；终端编码与 Electron 对齐为 `utf8`、`gb18030`、`gbk`、`big5`、`latin1`。验证 host-key 分别确认、认证提示、字符往返、IME、Unicode、粘贴、鼠标、搜索、选择、缩放和输出背压，并修复该领域基线发现的问题。
- **代理 B：SFTP、传输与远程编辑器。** 补齐从本地文件管理器拖放文件/目录上传及目标目录识别；完善目录传输父子进度、暂停/恢复、失败重试和字节一致性。把 WinUI `TextBox` 预览编辑器替换为 Scintilla/Lexilla 原生宿主，对齐 CodeMirror 的主要编辑能力及已支持语言映射；保留远端基线冲突、脏关闭裁决、编码/BOM/EOL，并加入二进制与大文件保护。
- **代理 C：监控与转发。** 把监控补齐到 Electron 指标范围：逐核 CPU、磁盘容量与 I/O、进程 Top、套接字/TCP 状态、延迟及状态/错误呈现。接入真实转发活动连接数和字节计数，验证 local、remote、dynamic、断线和停止清理。

代理维护各自领域服务、控件和独立测试文件；不得修改主窗口集成文件、共享语言包或集中测试入口。主代理独占 `MainWindow.xaml(.cs)`、应用项目文件、集中测试入口和多语言包合并。新增用户文案必须进入全部语言包。

### 阶段 2：主代理集成与回归

主代理接入各领域控件，打包 Scintilla/Lexilla 资源，检查 RDP Worker 本机依赖及自检。RDP 音频/拖放不在本轮范围；如缺少构建工具或运行库导致 Worker 无法恢复，记录阻塞并确保界面不宣称该能力已支持。

### 阶段 3：独立复验

阶段 0 的验收代理在不改实现的前提下，对最终 x64 产物复跑 UI Automation、终端、SFTP/传输、编辑器、监控和转发验收。主代理处理复验缺陷并更新验收记录与功能矩阵。

## 接口与兼容约束

不新增 Electron IPC 通道或改变既有导出格式。SSH 使用既有 `auth.method`、`jumpHostId` 和 `terminal.charset`；跳板机只支持单跳，并对缺失目标、无效引用、循环及连接失败返回明确错误。Agent 私钥留在 Agent 内，仅请求签名，不复制或持久化私钥材料。

原生监控数据模型扩展为 Electron 指标的等价子集；转发遥测是运行时数据，不改已保存规则格式。传输父子项仅扩展原生队列/视图模型。编辑器继续遵守远端冲突和文件安全语义。用户可见文案须通过 `npm run check:i18n`。

## 验证与完成标准

先运行现有 Core 合同测试和 WinUI x64 Release 构建，输出到独立目录；在空闲端口启动仓库 SSH fixture，使用独立临时 SFTP 根目录，再运行 NativeSmokeRunner。实现后执行：

- `dotnet run --project windows/OpenFinalShell.Core.Tests/OpenFinalShell.Core.Tests.csproj -c Release`
- `dotnet publish windows/OpenFinalShell.App/OpenFinalShell.App.csproj -c Release -r win-x64 -p:Platform=x64 --self-contained true -o build/windows-native-acceptance/app-x64`
- `powershell -NoProfile -File scripts/buildNativeTerminal.ps1 -Architecture x64`
- `npm run typecheck`、`npm run check:i18n`
- 原生更新：验证签名清单、流式 SHA-256、非法重定向、活动会话安装门控、`/S /WAITPID` 旧进程等待、覆盖安装后重启及数据目录保留；发布流水线生成 x64/x86/ARM64 安装包和三份签名 feed。
- UI Automation：导航、设置、连接编辑/登录提示、终端输入、目录上传下载、拖放、队列控制、远程编辑保存/冲突/脏关闭、监控状态及三类转发启停。
- 协议测试：三种 Agent 接入方式、双 fixture 单跳连接和五种终端编码；SFTP/传输测试核对目录任务进度、暂停/恢复、失败重试和上传下载字节一致。
- 验收日志、截图和结构化结果写入 `build/windows-native-acceptance/`；更新 `docs/windows-native-acceptance.md` 和功能矩阵，逐项标为通过、失败或外部阻塞。

本轮只认本机 Windows 11 x64 证据。当前缺少真实 Linux 监控主机、RDP 测试服务、Android 互操作设备和签名发布环境；真实服务验收、RDP 音频/拖放、Android LAN Sync、签名更新/回滚、FinalShell 专用迁移、多窗口协调及引导/捐赠页面列为后续，不能因模拟测试而标为已验收。

## 2026-11-03 执行状态

- 阶段 0：完成基线环境、Git、Core、x64 发布、终端 probe 和 fixture smoke；基线原始应用窗口未被操作。
- 阶段 1：SSH Agent/单跳/五种编码、SFTP 拖放和父子传输、Scintilla/Lexilla 宿主、完整监控指标与三类转发遥测均已落代码。
- 阶段 2：最终 x64 包已修复 XBF/PRI、原生编辑器和终端 DLL 打包；终端动态标签布局、Unicode、临时目录、远端存在判断和原子重命名缺陷已在 UI 验收中修复。
- 阶段 3：最终本机 UI 流程已验证；独立复验结果记录于 `build/windows-native-acceptance/final-qa-round3/`。
- 仍未验收：真实 Linux、RDP、Android/Electron、签名发布、Windows 10、普通用户、x86/ARM64 真机，以及 IME/Narrator/DPI/多屏完整矩阵。