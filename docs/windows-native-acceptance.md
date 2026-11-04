# Windows 原生验收记录

此文件记录 Windows 11 x64 本机可复现证据。代码或 CI 构建通过不能替代其他架构、真实远端服务或普通用户权限下的验收。

## 2026-11-04 Electron 右键菜单与 WinUI 迁移入口复验

| 字段 | 结果 |
| --- | --- |
| 日期 | 2026-11-04 |
| 系统 | Microsoft Windows 11 Pro，Build 26300，x64 |
| 权限 | 当前会话为管理员；不代表普通用户结果 |
| Electron 代码检查 | `npm run typecheck`、`npm run check:i18n` 通过；生产 Renderer 构建写入 `build/windows-native-acceptance/upgrade-plan-final-20261104T1050/electron-build-final` |
| Electron 测试 | 131 个测试文件通过，1773 项通过；5 个文件、37 项按项目配置跳过 |
| 右键菜单 | 组件测试覆盖连接/分组目标、四角边界夹取、滚动/失焦/resize/Escape 关闭、方向键、Enter/Space 激活和目标不串线；菜单挂载 `document.body` |
| 迁移卡片 | 设置 → 关于区域显示 Electron 当前版本、原生版本、架构和安装状态；取消确认不会下载；导出需要二次口令；安装器启动后提供打开原生版按钮；更新源离线时仍保留已安装原生版入口 |
| 原生首启入口 | 隔离数据目录下 Windows UI Automation 识别 `Import from Electron`；证据为 `build/windows-native-acceptance/upgrade-plan-final-20261104T1050/native-first-run-uia.json` |
| 原生 x64 构建 | Self-contained Release 发布成功；产物为 `build/windows-native-acceptance/upgrade-plan-final-20261104T1050/app-x64` |
| 原生协议 smoke | SSH 密码/KBI、终端输入、SFTP 上传下载、暂停恢复、冲突重试和字节一致性通过；证据位于 `build/windows-native-acceptance/upgrade-plan-final-20261104T1050/` 下最新 `smoke-run-*` 目录 |
| 在线清单与安装包 | x64 `native-update-<arch>.json` 真实 GitHub 清单解析、RSA 签名和 SHA-256 下载校验通过；安装包 67,972,777 bytes，哈希 `ab851627123b3c8a8d33419da60c3f3e0c008d9a748aa0593cbab24dbd06661e` |
| 仍未完成 | 当前未启动用户已有 Electron 进程做 Windows UIA 右键实机截图；100/125/150% DPI、玻璃开关、IME、Narrator 和多显示器仍需后续真机矩阵。下载资产当前 Authenticode 状态为 `NotSigned`，不能当作签名发布验收通过 |

结构化结果：`build/windows-native-acceptance/upgrade-plan-final-20261104T1050/upgrade-acceptance-results.json`。本节只认本机 Windows 11 x64 管理员会话证据，Electron 仍是正式默认客户端，WinUI 3 仍是独立预览客户端。

## 2026-11-03 最终本机验收

| 字段 | 结果 |
| --- | --- |
| 日期 | 2026-11-03 |
| 系统 | Microsoft Windows 11 Pro，Build 26300，x64 |
| 权限 | 当前会话为管理员；不代表普通用户结果 |
| Git 基线 | `b345ffe`，工作区含既有及本轮未提交修改 |
| 客户端 | 核心运维闭环 `app-x64/OpenFinalShell.App.exe`；自动更新最终代码 `publish-script-x64/OpenFinalShell.App.exe` |
| 数据隔离 | `OFS_NATIVE_TEST_MODE=1` 与独立 `OFS_NATIVE_TEST_DATA_DIR`；生产默认目录未用于本轮验收 |
| 后端 | 仓库内 SSH/SFTP fixture，空闲本机端口；SFTP 根目录位于 `build/windows-native-acceptance/` |
| 结构化证据 | `final-results.json`；自动更新端到端 `update-final-results.json` 与 `updater-e2e-result.json`；独立复验 `final-qa-round3/results.json` |
| 结论 | 核心运维闭环及原生自动更新 0.30.32→0.30.33 的本机 x64 验收通过；真实 Linux、RDP、Android、GitHub Release 触发、Authenticode 与 x86/ARM64 真机仍为外部阻塞 |

核心运维闭环定版发布使用计划规定的原命令执行，退出码为 0：

```powershell
dotnet publish windows/OpenFinalShell.App/OpenFinalShell.App.csproj -c Release -r win-x64 -p:Platform=x64 --self-contained true -o build/windows-native-acceptance/app-x64
```

发布包已确认包含 `App.xbf`、`MainWindow.xbf`、`Themes/Windows10.xbf`、`Themes/Windows11.xbf`、`OpenFinalShell.App.pri`、`Scintilla.dll`、`Lexilla.dll`、`ofs-terminal.dll` 和第三方许可。文件哈希见 `final-results.json`。

自动更新最终代码通过 `windows/publish-native.ps1` 重新发布到独立目录 `build/windows-native-acceptance/publish-script-x64`，避免覆盖上述既有验收产物；0.30.33 升级目标位于 `updater-target-x64`。

## 自动化与协议结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core 合同测试 | PASS，113 项 | `update-service-tests.log`，退出码 0；包含签名清单、损坏包、非法重定向和版本门控 |
| SSH 专项合同测试 | PASS，23 项 | `final-native-ssh-tests.log`，退出码 0 |
| SSH_AUTH_SOCK 命名管道、Windows OpenSSH Agent、Pageant 协议 | PASS | SSH 专项测试覆盖身份列举与签名帧；Pageant WM_COPYDATA/共享内存 |
| 单跳跳板机 | PASS | 双本机 fixture，独立确认跳板和目标 host key，终端/SFTP 到达目标，缺失和嵌套引用明确失败 |
| 五种终端编码 | PASS | `utf8`、`gb18030`、`gbk`、`big5`、`latin1` 分块输出与输入往返 |
| local / remote / dynamic 转发 | PASS | SSH 专项测试完成真实 TCP/SOCKS5 流量、双向字节统计、活动连接归零及停止清理 |
| SFTP 直接上传下载、重命名 | PASS | `final-ssh-sftp-smoke.log` |
| SFTP 慢速暂停/恢复与冲突重试 | PASS，19 项集成 smoke | `final-integrated-smoke.log` |
| 队列上传、缺失目标判断、原子提升 | PASS | 队列任务 `Completed`，远端/本地上传字节一致 |
| 慢速暂停/恢复与失败重试 | PASS | 2 MiB 延迟写 fixture 保留非空 partial 后继续；冲突失败移除后重试，最终字节一致 |
| 远程编辑器原子保存 | PASS | 同目录临时文件、精确 RENAME、回滚路径；远端回读字节一致 |
| Terminal native probe | PASS | x64 probe；增加宽字符单元格和 UTF-16 代理项检查 |
| Scintilla/Lexilla x64 构建 | PASS | `native-editor-default-build.log`，退出码 0 |
| TypeScript typecheck | PASS | `final-typecheck.log` |
| 10 种语言与 i18n 键检查 | PASS，基准 1247 keys | `final-typecheck.log` |

CMake/CTest 仍未安装，因此未执行 `ctest`；本轮原生合同和 probe 使用仓库内现有项目与脚本完成。

## 原生自动更新器本机结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| RSA 签名清单与固定公钥 | PASS | 实际 0.30.32 x64 清单的 `sha256` 和 RSA 签名均与内嵌公钥匹配 |
| 流式下载与损坏包拒绝 | PASS | Core 合同覆盖同长度篡改字节、清单签名篡改和非法重定向终址 |
| 版本化 NSIS 构建 | PASS，x64 | `build/windows-native-acceptance/native-installer/OpenFinalShell-NativePreview-0.30.32-x64-Setup.exe` |
| 旧进程等待与重启 | PASS | 安装器持有 `/WAITPID` 句柄，旧进程存活时未覆盖；旧进程退出后安装完成并重启新版 |
| 本机签名 feed 完整升级 | PASS | `updater-e2e-result.json`：0.30.32 自动下载 0.30.33，应用内确认后静默覆盖安装，重启为 0.30.33；截图见 `updater-e2e-upgraded-0.30.33.png` |
| 覆盖安装数据保留 | PASS | 端到端升级前后 SQLite 数据库和独立 sentinel 均存在，sentinel 哈希不变；另有 `update-overwrite-smoke.json` |
| 卸载数据保留 | PASS | `update-uninstall-smoke.json`：卸载删除安装目录与注册表项，同时保留数据库、数据目录和 sentinel |
| x64/x86/ARM64 发布与清单 | PASS（构建/签名） | 三个自包含发布和版本化 NSIS 均在本机交叉构建；`native-update-feed-validation.json` 校验三份清单摘要与 RSA 签名，`actionlint` 检查通过。x86/ARM64 未在对应真机启动 |
| GitHub Release 在线路径 | 外部阻塞 | 本机已完成同协议 loopback feed 端到端升级；尚无可发布的 tag/secret，GitHub 真实网络路径不标记为已验收 |

隔离安装证据位于 `update-installer-smoke.json` 与 `update-overwrite-smoke.json`。测试使用独立安装目录、`OFS_NATIVE_TEST_MODE=1` 和独立数据目录。

## WinUI UI Automation 本机结果

| 流程 | 结果 | 证据与边界 |
| --- | --- | --- |
| 启动、Windows 11 主题资源 | PASS | 最终 x64 包直接启动，窗口标题与平台配置正常 |
| 导航、设置 | PASS | Connections、Transfers、Port forwarding、Settings 等 UIA 控件可读取和进入 |
| 新建连接编辑器 | PASS | SSH/RDP、认证、Agent、代理、单跳跳板机、五种终端编码、终端类型及超时控件均出现 |
| SSH 登录与终端 | PASS | 隔离 fixture 登录，终端尺寸约 1039×467；命令和输出往返 |
| Unicode/CJK 终端文本 | PASS | UIA 文本无 U+FFFD；原生探针验证宽字符及 continuation cell |
| 标签切换后终端状态 | PASS | 从终端切到监控再返回，原命令输出仍可读取 |
| SFTP 浏览 | PASS | 远端根目录和文件类型、大小、权限可读取 |
| SFTP 上传 | PASS | 最终集成 UIA 上传 23 bytes，队列 Completed 100%，本地/远端 SHA-256 一致；另有主代理 31-byte UI 复测 |
| SFTP 下载 | PASS | 13 bytes；队列显示 `Download · demo.conf · Completed · 100%`；归档于 `downloads/final-download-uia.conf` |
| 远程编辑器加载 | PASS | Scintilla HWND、`props` lexer、UTF-8、LF、文件大小和 UIA 文本均可用 |
| 远程编辑器保存 | PASS | `Ctrl+S` 后状态清除 Modified，远端 `demo.conf` 保存为 21 bytes；证据见 `editor/final-editor.json` |
| 远端冲突 | PASS | 外部修改后保存出现 `Remote file changed`，提供 Overwrite / Cancel |
| 脏关闭裁决 | PASS | 关闭脏标签出现 `Unsaved changes`，提供 Save / Discard / Cancel |
| 监控 | PASS（fixture） | `Monitor: Running`；逐核 CPU、内存、网络、磁盘容量/I-O、进程 Top、socket、TCP 状态、uptime、直连与 SSH 延迟均显示 |
| 本地转发 UI 与遥测 | PASS | 实际连接回显 19-byte 测试载荷，页面累计 38 B；停止后状态 Stopped 且活动连接为 0 |
| remote / dynamic UI 启停 | PASS（基础 UI） | 三类型规则编辑器、启停控件可用；真实协议流量由 SSH 专项测试覆盖 |

截图：`main-uia/final-terminal.png`、`main-uia/final-monitor-validated.png`。远程编辑器文本与状态由 UIA 树及远端回读字节共同确认。

## 本轮修复的定版缺陷

- 标准 `dotnet publish -o` 未复制根 XBF、Theme XBF 和 `OpenFinalShell.App.pri`，导致启动时找不到 `ms-appx:///Themes/Windows11.xaml`；发布后资源复制现已纳入应用项目。
- WinUI `TabView` 将动态内容压到 1 像素且强制尺寸会触发 `E_BOUNDS`；现采用原生标签栏加独立 `ContentControl` 内容宿主，终端获得正常高度。
- 标签切换时终端控件 `Unloaded` 销毁 libvterm，返回后丢失输出；解析器现随会话/标签生命周期保存并释放。
- 关闭终端标签但保留同一 SSH/SFTP 会话时，输出泵现会先解除终端事件绑定，避免后续远端输出重新创建已关闭终端的解析器。
- libvterm 宽字符 continuation cell 使用 `0xffffffff` 和代理项表示，原绘制路径抛异常或绘制替换符；现安全跳过 continuation、合并代理对并过滤无效码位。
- 未打包 WinUI 进程不能使用 `ApplicationData.Current.TemporaryFolder`/`StorageFile.CopyAsync`；上传暂存改为应用自有 `%TEMP%/OpenFinalShell.NativeTransfers`。
- SSH.NET `Get` 对缺失 fixture 路径可能返回空名称对象，造成新文件误判冲突；`TryGetAsync` 现先调用 `Exists` 并验证名称。
- SSH.NET `RenameFileAsync` 会先对目标执行 REALPATH；对不存在的原子目标，简化 SFTP fixture 返回根目录并触发权限错误。传输与编辑器保存改用原始 RENAME 请求并保留回滚。
- `UploadFileAsync` 在 fixture 上不能完成临时编辑文件写入；原子保存改为直接打开临时文件、写完并 flush。
- 构建脚本产物名为 `lexilla.dll`，项目原先只匹配 `Lexilla.dll`；项目现显式链接为运行时 `Lexilla.dll`。
- 快速重复打开转发编辑器会触发“一次只能打开一个 ContentDialog”并退出；现增加单实例保护。

## 未完成或外部阻塞

- 真实 Linux 监控主机、权限不足、断线和高频采集未测。
- IME composition、Narrator、高对比度、DPI/多显示器、减少动画和键盘全流程未完成真机矩阵。
- Windows Explorer 到 SFTP 的 OLE 拖放实现已完成，但未取得可靠的 UIA 自动拖放证据。
- 文件级慢速暂停/恢复和失败重试已通过 fixture 验证；长目录父子进度的长时 UI 证据仍未取得。
- 远程编辑器多文档/独立窗口、大文件性能和完整语言矩阵未验收。
- FreeRDP Worker 在本机缺少运行时 DLL，真实 RDP、音频和文件拖放阻断。
- Electron/Android LAN Sync、Android API 矩阵和真实网络防火墙未测。
- 自动回滚、真实 GitHub Release 在线升级、Authenticode 发布者签名以及 x86/ARM64 真机更新未测。
- FinalShell 专用迁移、多窗口协调、引导和捐赠页面仍未完成本体验收。
- Windows 10 22H2、普通用户、x86 与 ARM64 真机未验收；本轮只认可 Windows 11 Build 26300 x64 管理员会话。

Electron 继续作为正式 Windows 客户端。上述外部阻塞关闭前，原生版保持预览身份。
