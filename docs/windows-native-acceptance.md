# Windows 原生验收记录

此文件记录 Windows 11 x64 本机可复现证据。代码或 CI 构建通过不能替代其他架构、真实远端服务或普通用户权限下的验收。

## 2026-11-06 Electron v1/v2 导入兼容续补

原生迁移入口此前只接受 v2 整包加密信封，无法导入 Electron 默认生成的 v1 文件。本批加入 v1 读取：明文配置无需口令；当 `includesSecrets=true` 且存在 `secrets` 块时只对凭据块要求导出口令；v2 仍要求整包口令。凭据解密后沿用原有类别筛选、引用重写、冲突策略、事务写入、备份和本机 DPAPI 重存，不复制 Electron 的密钥材料。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core | PASS，293 项 | `build/windows-native-acceptance/electron-v1-import-20261106/core-tests.log` |
| Native SSH | PASS，49 项 | `build/windows-native-acceptance/electron-v1-import-20261106/native-ssh-tests.log` |
| Electron 迁移/加密/LAN Sync | PASS，45 项 | `build/windows-native-acceptance/electron-v1-import-20261106/electron-migration-tests.log` |
| TypeScript / 本地化 | PASS | `npm run typecheck`、`npm run check:i18n` |
| WinUI x64 self-contained | PASS | `build/windows-native-acceptance/electron-v1-import-20261106/app-x64/` |
| 原生窗口导入实测 | BLOCKED | 自动化窗口绑定问题仍在；未操作安装版或默认数据目录 |

本批关闭的是 Electron→原生的格式兼容缺口，不代表完整 WinUI 用户流程、真实 FinalShell 数据或最终安装包 UI 已验收。

## 2026-11-06 SFTP/终端默认交互语义续补

原生设置面板此前对部分空配置使用了与 Electron 不同的 UI 默认值，且 SFTP/终端运行时在缺失设置时各自使用回退值。本批将默认值集中到 `NativeSettings`，并让设置控件与运行时共同读取：`showHiddenFiles=true`、`doubleClickAction=download`、`terminal.rightClick=paste`、`terminal.copyOnSelect=true`。显式保存的 `open/menu/false` 值仍保持，未知值回退到共享默认。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core | PASS，296 项 | `dotnet run --project windows/OpenFinalShell.Core.Tests/OpenFinalShell.Core.Tests.csproj -c Release` |
| Native SSH | PASS，49 项 | `build/windows-native-acceptance/sftp-terminal-defaults-20261106/native-ssh-tests.log` |
| TypeScript / 本地化 | PASS | `build/windows-native-acceptance/sftp-terminal-defaults-20261106/typecheck.log`、`i18n.log` |
| WinUI x64 self-contained | PASS | `build/windows-native-acceptance/sftp-terminal-defaults-20261106/app-x64/` |
| 真实窗口交互 | BLOCKED | 隔离 Native 窗口启动/绑定仍受本机策略阻断；未操作安装版或默认数据 |

## 2026-11-04/05 全功能对齐批次一续验（qa19 基线、qa20 修复复验）

当前权威逐流程状态见 [windows-native-parity-status.md](windows-native-parity-status.md)。下文历史“核心运维闭环通过”只表示当时列出的局部证据，不能作为完整替代 Electron 的结论。

本批 Windows 11 Pro Build 26300 x64 管理员、隔离数据及本机 fixture。自包含 0.30.34 构建位于 `build/windows-native-acceptance/parity-batch1-20261104/app-qa19/`。未安装、未发版，未替换既有客户端或生产数据。

| 检查 | 当前结果 / 证据 |
| --- | --- |
| Core | 190 项通过，`core-final-qa19.log` |
| SSH/保存/监控/转发 | 49 项通过，`ssh-final-qa19-fixed.log`；含真实 Windows 文件系统 symlink 解析/改指保护、变目录拒绝、SFTP chmod 位值及临时文件先限权后写内容 |
| NativeSmokeRunner | 24 个断言通过，`smoke-final-qa19.log`；编码无损、非原子回退显式同意、暂停恢复/重试与字节一致 |
| Electron SFTP | 18 项通过，`sftp-electron-final-qa19.log` |
| Renderer | 2 文件、16 项通过，`renderer-latest.log`；不是完整 Renderer 套件 |
| TypeScript / i18n | typecheck 通过；10 语言、1314 keys 通过，`typecheck-latest.log` / `i18n-final-qa19.log` |
| 原生终端 | 原 Windows PowerShell 调用受 execution policy 阻止；当前 PowerShell host 执行同脚本及 probe 通过，`terminal-latest.log` / `terminal-current-host.log` |
| x64 发布输出 | `publish-qa19.log` 成功，包内 ofs-terminal.dll 与验证构建哈希一致；精确文件哈希见 `parity-results.json` |
| 历史局部 UI | qa13 同屏/查找/导航保持/默认目录下载字节一致；qa14 编码选择与无 BOM 重读、命令对话框取消及活动会话退出确认。截图/tree 绑定原构建，不能用于证明 qa19 通过 |
| 最终 UI | qa19 已做部分实际复验；qa20 独立构建复验了命令库多行正文回显修复。整套最终 UI 矩阵仍未完成 |
| RDP runtime | stage manifest=optional，严格包检查失败；qa19 Worker 自检退出 0xC0000135，无 HELLO，缺少本机依赖；见 rdp-package-check.log、rdp-worker-self-test-qa19.json |
| 未关闭 | 批次一完整迁移编辑重启/树与设置等 UI 矩阵、批次二至四余项、OS DPI/IME/高对比度/普通用户/其他架构/真实服务及最终安装包 |

所有本批路径相对 `build/windows-native-acceptance/parity-batch1-20261104/`。复现步骤 `reproduce.md`，分层结果 `parity-results.json`。Windows fixture 的权限帧与报告值不能替代真实 Linux 权限、ACL、owner 和并发写者验收。

## 2026-11-05 qa19/qa20 最终 UI 续验

复验环境为 Windows 11 Pro Build 26300 x64、管理员会话。qa19 与 qa20 均是隔离的 0.30.34 自包含开发构建；使用独立数据目录和本机 SSH/SFTP fixture，未触碰安装客户端或生产数据。qa20 数据由 qa19 隔离库的 SQLite 备份创建。

qa19 实际观察到连接树搜索与嵌套分组、连接/分组右键菜单、SSH fixture 会话，以及终端、SFTP、Scintilla 编辑器和监控同屏。还验证了导航保留终端和编辑器 HWND、查找替换、脏关闭取消、非原子保存提示、远端冲突取消、命令库另存和模态窗口快捷键保护。相应证据见 `build/windows-native-acceptance/final-ui-qa19-20261105/01` 至 `20` 的 UIA 记录和截图；真实服务和完整 OS 可访问性矩阵未覆盖。

qa19 发现命令库多行命令虽已完整写入隔离数据库，但重新打开编辑窗口只呈现第一行。修复将多行文本框的 `AcceptsReturn` 初始化提前到预填 `Text` 之前。qa20 实际重新打开同一条已保存的两行命令，界面和 UI Automation 均显示 `# QA19 draft only` 与 `# not sent`，自动回车开关仍为关闭；随后取消对话框，没有保存或发送命令。结果通过。证据：`build/windows-native-acceptance/final-ui-qa19-20261105/21-qa20-multiline-fixed-tree.json`、`21-qa20-multiline-fixed.jpg`。

qa20 是隔离开发输出，不是安装器或正式发行包。该复验只关闭多行编辑回显缺陷，不代表完整功能对齐，也不代表 DPI、IME、高对比度、Narrator、普通用户、其他架构、真实远端服务或最终安装包已验收。qa19/qa20 结构化结果及构建哈希见 `build/windows-native-acceptance/final-ui-qa19-20261105/ui-results.json` 与 `build/windows-native-acceptance/parity-batch1-20261104/parity-results.json`。

## 2026-11-06 AI Provider 迁移契约与隔离发布复核

Electron 加密迁移现将 AI Provider 元数据映射为共享格式 `aiProfiles/apiKeyRef`。用户勾选“包含已保存凭据”时，Token 从 Electron Vault 解密后只进入 v1/v2 加密的 secret map；原始 DPAPI 密文与 Token 明文不会写入导出文件。文件导入和 LAN Sync 都可单独选择 AI Provider 类别，错误口令、冲突策略、重复导入、无 Token、null 引用、只导 AI 类别以及覆盖时清理旧 Token 均有测试覆盖。WinUI 共享 envelope/Core 已识别该类别；原生迁移确认框现显示 AI Provider 数量。

| 检查 | 结果 / 证据 |
| --- | --- |
| Electron 完整测试 | `npm test`：131 个文件通过、5 个文件跳过；1779 项通过、37 项跳过 |
| TypeScript / 文案 | `npm run typecheck`、`npm run check:i18n` 通过；10 语言、1324 个 key |
| Native Core | 240 项合同检查通过 |
| 隔离 SSH/SFTP smoke | 24 项通过；独立回环 fixture、独立 `fixture-sftp`；日志 `build/windows-native-acceptance/parity-ai-migration-20261106/native-smoke.log` |
| Native x64 Release | self-contained 发布成功；`build/windows-native-acceptance/parity-ai-migration-20261106/app-x64/OpenFinalShell.App.exe`；SHA-256 `831389D3DF889F26966D10605141C17D77A7C61E1F65BE2507DB6D97D956EE2E` |
| 实际 UI 绑定 | 尝试读取当前隔离预览窗口 `11669444` 并刷新绑定一次；两次均报 `window id 11669444 no longer belongs to ...; current owner is ...`。未执行点击或导入，原生迁移 UI 流程仍未验收 |

逐步复现命令和结构化结果见 `build/windows-native-acceptance/parity-ai-migration-20261106/reproduce.md` 与 `ai-migration-results.json`。本轮未覆盖完整 UI 矩阵、真实 AI Provider、Linux/RDP/Android、其他 Windows 权限或架构；原生版继续保持预览版。

## 2026-11-06 SFTP 批量上传冲突处理

文件选择、目录选择和 Explorer 拖放上传已共用顶层批次规划器：按 Electron 的设置决定自动覆盖/跳过/重命名，`ask` 模式对整批只弹一次选择；拒绝重复目标名、远端符号链接覆盖和文件/目录类型错配。无法枚举远端目标目录时不入队，并显示检查失败信息。目录上传保留父子传输任务，覆盖决定作用于已有顶层目录中的文件。该批次当时下载多选冲突仍逐项处理，上传跳过项尚未单独显示；后者已在 2026-11-06 后续批次补齐，见下节。

| 检查 | 结果 / 证据 |
| --- | --- |
| Native Core 合同 | 248 项通过，其中新增 8 项覆盖批次 ask、skip、overwrite、rename、名称保留、类型冲突、symlink 与重复名；完整日志见 `core-tests.log` |
| SSH/SFTP smoke | 24 项通过；仓库 fixture 使用动态回环端口和本证据目录下独立 `fixture-sftp` 根目录；日志见 `native-smoke.log`。该 smoke 覆盖现有服务与队列，不验证新冲突对话框 |
| TypeScript / i18n | `npm run typecheck` 和 `npm run check:i18n` 通过；10 种语言、1324 keys；日志见 `typecheck.log`、`i18n.log` |
| 隔离 x64 Release | self-contained 发布成功，`app-x64/OpenFinalShell.App.exe`；SHA-256 `831389D3DF889F26966D10605141C17D77A7C61E1F65BE2507DB6D97D956EE2E`；日志见 `publish.log` |
| UI 自动化 | 未执行批量冲突点击与 Explorer 拖放；此前隔离窗口绑定仍有已记录的 owner mismatch，故此处只报告 Core/构建通过 |

结构化结果与复现步骤位于 `build/windows-native-acceptance/batch-upload-conflict-20261106/`。本地 fixture/规划器合同不替代真实 Linux 冲突路径或最终安装包验收。

## 2026-11-06 SFTP 跳过任务状态与隔离复验

补齐上传 skip 的队列语义：被跳过的文件现在作为终态任务显示为本地化状态文案，字节数保持为 0；目录父任务统计跳过子项，所有文件均跳过时父项进入 `Skipped`，混合成功/跳过时完成百分比按终态显示。跳过项不会被队列控制误恢复或重试，清理已完成可移除父子跳过任务。Native Core 总计 252 项合同通过，其中 4 项覆盖跳过状态行为。

| 检查 | 结果 / 证据 |
| --- | --- |
| Native Core 合同 | 252 项通过；日志 `build/windows-native-acceptance/skipped-transfer-20261106/core-tests.log` |
| SSH/SFTP fixture smoke | 24 项通过；动态回环端口 58916，独立根目录；日志 `build/windows-native-acceptance/skipped-transfer-20261106/run-02/native-smoke.log` |
| x64 Release | self-contained 发布成功，0.30.34；launcher SHA-256 `831389D3DF889F26966D10605141C17D77A7C61E1F65BE2507DB6D97D956EE2E`，程序集 SHA-256 `A2A30CCF107E47E531474D09632A45C1F177FB25C2B3587F098A5D3136E02AA1` |
| TypeScript | `npm run typecheck` 通过；日志 `build/windows-native-acceptance/skipped-transfer-20261106/run-02/typecheck.log` |
| i18n | `npm run check:i18n` 通过，10 种语言/1324 keys；日志 `build/windows-native-acceptance/skipped-transfer-20261106/run-02/i18n.log` |
| UI 自动化 | 尝试绑定隔离窗口失败，返回窗口 owner mismatch；没有点击或截图，实际冲突队列呈现仍待复验 |

结构化状态与复现步骤位于 `build/windows-native-acceptance/skipped-transfer-20261106/results.json` 和 `reproduce.md`。下载同名文件替换/目录合并的代码行为已与 Electron worker 对照；本批未通过 UI 自动化点击复验。真实 Explorer 拖放和真实 Linux 冲突流程仍未验收。

## 2026-11-06 下载同名文件替换复验

Electron worker 会把下载内容先写入临时文件，验证远端文件大小/修改时间后替换本地目标。原生 SFTP 页面先前逐项询问 skip/rename/overwrite，和 Electron worker 不同。现已移除下载入口的额外冲突裁决，批量文件下载保留 Electron 的同名替换行为；目录下载合并目录内容，并保留本地符号链接/reparse 点与文件/目录类型保护。

| 检查 | 结果 / 证据 |
| --- | --- |
| 隔离 x64 Release | self-contained 发布成功，0.30.34；程序集 SHA-256 `575D657571389577C0FB20FDE7A49E65615C9196E858192DEC69F43BF9BE4D27`；日志 `build/windows-native-acceptance/download-conflict-20261106/publish.log` |
| SSH/SFTP fixture smoke | 26 项通过；新增“已存在本地文件被验证后的下载替换”及最终字节核验；日志 `build/windows-native-acceptance/download-conflict-20261106/native-smoke.log` |
| UI 自动化 | 未执行；隔离窗口绑定错误仍在，文件选择器和批量下载入口的实际视觉流程待复验 |

结构化结果和复现步骤位于 `build/windows-native-acceptance/download-conflict-20261106/results.json` 与 `reproduce.md`。本验证只覆盖 queue 层下载覆盖行为，不代表 Windows 文件选择器、目录树下载或最终安装包 UI 已验收。

## 2026-11-06 下载目标选择入口对齐

Electron 未配置默认下载目录时，单个文件和多个条目都会打开目标目录选择器；WinUI 原先对单文件打开另存为文件选择器。现统一改为 FolderPicker，后续按每个远端基名放入选中目录，队列仍在传输校验后替换同名目标。

| 检查 | 结果 / 证据 |
| --- | --- |
| 隔离 x64 Release | PASS，0.30.34；程序集 SHA-256 `90AB4030DD10BE6B861C84B72088C2C129BDBCE6C8303996FD5CB2CFF7DF25F9`；日志 `build/windows-native-acceptance/download-flow-20261106/publish.log` |
| UI 自动化 | BLOCKED，窗口 owner mismatch；没有打开选择器、输入或截图 |

结构化结果与复现步骤见 `build/windows-native-acceptance/download-flow-20261106/results.json`、`reproduce.md`。本项仅确认代码和隔离构建，不能标记为 Picker 实际交互通过。

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

## 2026-11-06 SFTP 快速删除原生接入

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| Native Core 安全与命令合同 | PASS，201 项总合同（含 11 项快速删除断言） | `dotnet run --project windows/OpenFinalShell.Core.Tests/OpenFinalShell.Core.Tests.csproj -c Release`；覆盖 POSIX 单引号转义、`--`、残留标记、根/浅路径、相对路径、点段、控制字符、批次聚合、退出码未知和断线 |
| SSH 合同 | PASS，49 项 | `dotnet run --project windows/OpenFinalShell.NativeSsh.Tests/OpenFinalShell.NativeSsh.Tests.csproj -c Release`；该 fixture 的 exec 通道镜像命令，不会真实执行 shell 删除，因此不作为 rm 行为证据 |
| Electron Renderer 测试 | PASS，131 个文件、1773 项通过；5 个文件及 37 项跳过 | `npm test`；仅作为共享 Renderer 回归证据，不覆盖原生 UI 行为 |
| WinUI x64 Release 自包含构建 | PASS | 最终源代码构建：`build/windows-native-acceptance/flow-parity-20261106/app-fast-delete-x64-uiresult/` |
| TypeScript / i18n | PASS | `npm run typecheck`；`npm run check:i18n`（10 种语言、1315 个 key） |
| 最终 SFTP 右键交互与真实 Linux 删除 | PENDING / 外部阻塞 | UI 自动化尚未绑定最新工作台窗口；不在生产主机执行删除。需在隔离 WinUI 窗口及真实 Linux 测试环境中确认启用/关闭、用户取消、部分失败和刷新行为 |

UI 复验启动请求被自动审批拒绝（结果为 `blocked by policy`），没有创建 fixture/app 进程、没有发送输入或捕获截图；因此这不是功能失败，也不能作为 UI 通过证据。结构化结果和具体拒绝动作见验收 JSON。

实现范围仅覆盖 Electron 的受保护快速删除流程：SFTP 右键菜单在选择项均为非符号链接目录且设置开启时出现；确认前重新检查远端类型并展示实际命令。Core 再独立校验路径、引用 POSIX 安全引号并限批执行；断线/无退出码标记为未知，刷新列表后显示结果。目录 tar 打包下载已在 2026-11-06 接入 Native Core 与 WinUI 入口；Core 与 x64 构建通过，但最终 UI 和真实 Linux tar/SFTP 仍待验收，详见下方验收记录与功能差异矩阵。快速删除验收结构化数据位于 `build/windows-native-acceptance/flow-parity-20261106/fast-delete-results.json`。

## 2026-11-05 原生工作台排版重构

本批只重排已有入口和页面层级，没有补实现 Electron 缺少的服务或业务功能，也没有安装或发布。保留 Windows 原生标题栏；应用内部改为活动栏、上下文侧栏、会话工作区和状态栏，设置/AI/LAN Sync 作为覆盖面板。活动入口保持会话工作区不变。

| 检查 | 结果 |
| --- | --- |
| 系统 | Windows 11 Pro Build 26300 x64；管理员会话 |
| 构建基线 | Git `2e18659`，应用版本 0.30.34，x64 Release，自包含开发构建 |
| 构建 | PASS；`publish.log`，产物 `layout-reflow-final-20261105/app-x64-responsive/` |
| Core 合同 | PASS，190 项；`core-release.log` |
| TypeScript | PASS；`typecheck.log` |
| i18n | PASS，10 种语言、1315 个 key；`i18n.log` |
| 包哈希 | Launcher `OpenFinalShell.App.exe`: `831389D3DF889F26966D10605141C17D77A7C61E1F65BE2507DB6D97D956EE2E`; managed assembly `OpenFinalShell.App.dll`: `98220B67C5DE3E2CF1C6CA400659E46D88D7D7CA96C44697739428C360E3FDB3` |
| 工作区尺寸适配 | 代码包含侧栏限宽、工作区最小内容宽度，以及极窄窗口下可由活动栏再次打开的临时侧栏抽屉；只完成编译检查，尚未通过窗口实测 |
| UI Automation / 截图 | BLOCKED；隔离窗口重启后已列入新窗口清单，但自动化绑定重试失败；未发送输入、未截屏 |
| 系统 DPI / 高对比度 / 多语言窗口矩阵 | PENDING；未实测 |

隔离数据目录已创建：`layout-reflow-final-20261105/data-layout-ui-20261105/`。用户于 2026-11-06 重启隔离构建，桌面清单显示唯一目标窗口标题 `OpenFinalShell Native Preview · windows-11 · isolated test`，新窗口 ID 为 `11669444`。刷新应用清单后，自动化绑定仍返回“window id 11669444 no longer belongs to …; current owner is …”错误，报出的 owner 与目标进程相同；再次刷新窗口清单并重试，结果未变。本轮没有发送界面输入，也没有捕获截图，因此菜单、侧栏、覆盖面板、会话保持、尺寸/缩放/主题/语言矩阵全部仍未实测。当前结论为“排版代码与构建通过，UI 复验受自动化窗口绑定故障阻塞”，不能标排版验收通过。启动命令、错误和复现步骤见该目录的 `reproduce.md`；结构化状态见 `layout-results.json`。

本轮后续缺口仍按 [windows-native-parity-status.md](windows-native-parity-status.md) 追踪。排版完成不表示命令库、RDP、AI、FinalShell 迁移、LAN Sync、独立编辑器窗口的实机复验、全部设置、首次引导或其他未完成能力已实现。

## 2026-11-06 AI 代码块与 SSH 终端填入

原生 AI 对话现在将回答中的 Markdown fenced code 分块渲染为不执行的原生文本，可复制整块或单行；shell 类代码块可选一个已连接 SSH 会话后填入整块或非空、非注释行。填入前限制 32,768 字符、拒绝控制字符；多行和 Tab 仅在远端已启用 bracketed paste 时接受。填入只写入终端输入，不发送 Enter。终端状态来自 libvterm parser，不从 AI 输出或当前显示文本推测。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| Native Core AI 解析/填入合同 | PASS，新增 4 项；Core 总计 227 项 | 解析 prose/tilde fence/语言标签/未闭合块；行尾归一化；超长、空值和控制字符拒绝；多行模式门控 |
| libvterm bracketed-paste C ABI | PASS | `build/windows-native-acceptance/flow-parity-20261106/ai-terminal-x64/terminal_probe.exe`；覆盖 bracketed paste 默认关闭、跨 feed 分块开启、关闭后状态、关闭模式下单行输入无 bracket 包装 |
| WinUI x64 Release 自包含构建 | PASS | `build/windows-native-acceptance/flow-parity-20261106/ai-native-x64/`；包含新 `ofs-terminal.dll`，其 SHA-256 为 `31EE95201DBF3E8EE27A7B4E46D24761072ACA1D31CE94A6A0A0A07F9284C0AC` |
| Renderer 回归 | PASS，131 个文件/1773 项；5 个文件/37 项跳过 | `npm test -- --reporter=dot`；已有 DOM mock 警告不影响通过结果 |
| TypeScript / i18n | PASS | `npm run typecheck`；`npm run check:i18n`，10 种语言、1316 个 key |
| AI Provider / WinUI 实际交互 | BLOCKED | 已尝试绑定当前隔离窗口，但 UI 自动化对窗口 ID `11669444` 返回 same-owner 绑定失败；未发送输入、未截屏、未连接真实 Provider。AI UI、流式呈现、剪贴板与 SSH 填入仍待实测 |

复现构建采用独立数据与输出目录，不替换已安装版。结构化结果及产物哈希见 `build/windows-native-acceptance/flow-parity-20261106/ai-flow-results.json`。仓库 PowerShell 脚本执行被当前执行策略拒绝，因此用同一脚本定义的 clang 源文件、目标与参数直接构建并运行 terminal probe；编译与 probe 结果通过。该操作未更改执行策略。UI 绑定错误与既有最终工作台验收中的窗口归属故障一致，但本轮只记录实际观察到的失败，不推断具体成因。

## 2026-11-06 原生 SFTP 打包下载接入

本批将 Electron `src/main/sftp/packTransfer.ts` 的目录下载语义接入 Native Core 与 WinUI SFTP 目录下载入口。满足探测门槛时，队列在遍历远端子项前建立单个 tar 下载任务；否则沿用已有的逐文件父子任务，并在父项显示回退原因。设置项继续使用共享 `sftp.packedTransfer` 字段。UI 复验未执行，本批不代表界面或真实 Linux 主机已验收。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| Native Core 合同测试 | PASS，223 项 | `build/windows-native-acceptance/flow-parity-20261106/packed-transfer-x64/core-tests-final.log`；新增覆盖远端探测、空间与冲突判定、shell 引号、mktemp 路径约束、归档字节、链接跳过、越界/多顶层/ADS/设备名/大小写碰撞和空归档拒绝 |
| Native SSH 合同 | PASS，49 项 | `ssh-tests-final.log`；包含已有 SSH/SFTP 会话和 fixture 行为，但 fixture 的 exec 通道仅回显脚本，不能验证远端 tar 命令 |
| WinUI x64 Release 自包含构建 | PASS | 产物位于 `build/windows-native-acceptance/flow-parity-20261106/packed-transfer-x64/app-x64/`；Launcher SHA-256 `831389D3DF889F26966D10605141C17D77A7C61E1F65BE2507DB6D97D956EE2E`；Core SHA-256 `D78D2A5AAE39842C7E9AF0B04CB3843BBFD95967D0599DC4871EFF659B99DE09` |
| Renderer 回归 | PASS，131 个文件/1773 项；5 个文件/37 项跳过 | `renderer-tests.log`；只作共享前端回归证据 |
| TypeScript / i18n | PASS | `typecheck.log` 与 `i18n.log`；10 种语言、1315 个 key |
| SFTP 打包任务 UI / 真实 Linux tar | NOT RUN / 外部验收未完成 | 目录下载设置和入口已接线，但未启动最终构建做 UI 操作；仓库 SSH fixture 不运行 shell。需在隔离 WinUI 窗口及 Linux SSH/SFTP 测试主机验证 tar/mktemp 探测、打包、传输、解包字节、回退、取消/重试和远端临时文件清理 |

构建与复现信息、结构化结果位于 `build/windows-native-acceptance/flow-parity-20261106/packed-transfer-x64/`。本功能当前应标为“代码与 Core 合同完成，UI/真实远端运行待验收”，不能据此声称 WinUI 已与 Electron 全流程对齐。

## 2026-11-06 AI Provider 管理与总开关对齐

本批补齐 Electron AI 设置中的原生入口和服务约束：设置页增加 AI 助手总开关；AI 面板增加清 Token 与删除 Provider（至少保留一个配置）；清 Token/删除都先确认。Native Core 在关闭开关时阻止模型发现、连接测试、图片能力探测和聊天请求。Token 替换、清除和 Provider 删除在 SQLite 写事务内完成，旧凭据仅在没有任何实体继续引用时删除；迁移旧 `aiProviders/tokenRef` 时事务性合并到 `aiProfiles/apiKeyRef`。AI 配置页在关闭助手后仍可进入，以便重新启用或维护 Provider。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| AI 总开关与请求门控 | PASS，Core 合同 | 关闭时模型发现、连接测试、图片探测和流式聊天均在网络请求前拒绝；设置默认关闭与 Electron 默认设置一致 |
| Token 替换/清除与共享引用 | PASS，Core 合同 | 替换或清除删除孤立 secret；另一个 Provider 共用引用时保留；移除最后一个引用后清理 |
| Provider 删除与旧格式合并 | PASS，Core 合同 | 删除及 secret 清理事务化；旧 `aiProviders/tokenRef` 在保存时 CAS 合并到 `aiProfiles/apiKeyRef`，失败写入不产生部分状态 |
| Core 合同 | PASS，240 项 | `build/windows-native-acceptance/ai-provider-parity-20261106/core-tests.log` |
| 本地化 | PASS，10 种语言、1322 个 key | `build/windows-native-acceptance/ai-provider-parity-20261106/i18n.log` |
| TypeScript | PASS | `build/windows-native-acceptance/ai-provider-parity-20261106/typecheck.log` |
| x64 Release 发布构建 | PASS，自包含 | `build/windows-native-acceptance/ai-provider-parity-20261106/app-x64/`；`publish.log`；App DLL SHA-256 `910F506321C4863CC216732D0B71A89D928EF02837A2BDBDFCCBE2F7BEB2E130`；Core DLL SHA-256 `66CBB1EA85A3A8C444A1AEA9B717B37E9AC4C15B6651CC98A33B715E5BC74FCC` |
| 最终 AI UI Automation | BLOCKED | `sky.list_apps()` 返回隔离窗口 `11669444`；两次绑定均报“窗口不再属于目标 app，当前 owner 与目标 app 标识相同”。未发送输入、未改窗口状态、未截图；新开关和按钮没有实机 UI 通过证据。错误原文见 `build/windows-native-acceptance/ai-provider-parity-20261106/ui-binding.log` |
| Provider 实际网络服务 | 外部未测 | 使用 Fake HTTP Handler 验证合同，没有连接用户 Provider 或发送凭据 |

结构化结果：`build/windows-native-acceptance/ai-provider-parity-20261106/ai-provider-results.json`。本批不修改 Electron IPC、共享导出格式或已安装版；Electron 0.30.34 的 AI 配置仍未包含在 `exportData` 中，因此 Electron→原生的 AI 配置迁移继续列为未完成。

## 2026-11-06 WinUI 外观与下载目录设置续补

本批补齐两个与 Electron 设置流程的本机差距：设置增加八色强调色原生选择器，所选颜色映射到 WinUI Fluent Accent 资源并通过共享 `accent` 字段持久化；SFTP 下载目录设置增加系统 FolderPicker，同时保留手动路径输入。没有改变 Electron IPC 或迁移格式。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| Native Core 合同 | PASS，253 项 | `build/windows-native-acceptance/accent-parity-20261106/core-tests.log`；覆盖强调色读取、跨偏好并发局部保存、加密导出及非法强调色回退 |
| TypeScript / i18n | PASS | `npm run typecheck`、`npm run check:i18n`；10 种语言、1324 keys；本批复用已有 `settings.accent` 与 `conn.browse` 文案 |
| WinUI x64 Release 自包含构建 | PASS | `build/windows-native-acceptance/accent-parity-20261106/app-x64/`；App DLL SHA-256 `48543D55071B20E77564237156FD12F112A8AA382ACE4D634AFE3C1B19E602CF`；Core DLL SHA-256 `0641EE04152A4499400782265A5E2F96A81D8507AC7BE6C8FEAA3AECA76E1F9F` |
| 实际窗口操作、截图 | NOT RUN | 启动新隔离进程的执行请求被本机执行策略拒绝；未触发旧安装版、旧隔离版或默认数据目录。因此色板实时显示、Picker 操作与键盘焦点仍待实际 UI 复验 |

结构化结果位于 `build/windows-native-acceptance/accent-parity-20261106/accent-results.json`。本批只关闭设置代码与合同层的差距；不代表完整设置等价、整体功能对齐或最终安装包验收完成。

## 2026-11-06 FinalShell 专用导入入口续补

本批将 Electron 的 `finalshellScan` / `finalshellImport` 用户流程接入 WinUI：设置页增加“选择 FinalShell 数据目录”入口；扫描 `conn/*.json` 或目录根 JSON，显示 SSH/分组/无效/非 SSH/锁定密码统计和样本；用户可选择跳过同主机目标或创建副本。导入通过 NativeStore 事务和现有备份机制落地，保留嵌套分组，FinalShell 自有密码、代理、密钥和转发引用不伪造，密码不可解时提示首次连接重新输入。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| Native Core 合同 | PASS，259 项 | `build/windows-native-acceptance/finalshell-import-20261106/core-tests.log`；新增扫描分类、目录重复扫描去重、skip/duplicate、层级和密码不导入断言 |
| WinUI x64 Release 自包含构建 | PASS | `build/windows-native-acceptance/finalshell-import-20261106/app-x64/`；构建日志 `publish.log` |
| TypeScript / i18n | PASS | 复用现有本地化键；`npm run typecheck`、`npm run check:i18n` 已通过 |
| FinalShell 实际 UI / 用户目录 | NOT RUN | 新隔离窗口启动被本机执行策略拒绝；未打开目录选择器、预览对话框或写入用户数据。真实 FinalShell 旧版本样本仍待提供/验收 |

本批关闭的是原生缺少专用入口和扫描服务的代码差距，不等同于已完成真实 FinalShell 迁移或整体 Electron 全流程对齐。
### 2026-11-06 窗口状态与当前 UI 复验限制

- 新增原生工作区窗口状态持久化：恢复前校验 800×600 至 7680×4320 的尺寸范围，并保存最大化状态；非法或过大/过小值会被忽略。对应合同测试使 Native Core 总数达到 265 项。
- x64 自包含发布构建通过，产物位于 `build/windows-native-acceptance/window-bounds-20261106/app-x64/`；发布日志和合同测试日志在同目录。
- 使用当前隔离构建窗口进行 UI 复验时，桌面自动化接口仍返回“窗口不再属于同一应用标识，当前 owner 与目标 owner 同名”的绑定错误。未继续使用旧句柄，也未对安装版或默认数据目录做操作，因此本次没有新增 UI 操作、截图或尺寸恢复实测证据。

### 2026-11-06 原生 About / 更新入口

- 设置覆盖层新增 About 页面，复用共享本地化和更新服务，显示原生预览版本、Windows 环境/进程架构、更新检查按钮和变更说明入口；不新增更新通道，也不改变安装或数据逻辑。
- x64 Debug/Release 编译和 self-contained 发布均通过，产物位于 `build/windows-native-acceptance/about-page-20261106/app-x64/`。
- 当前隔离窗口仍无法通过桌面自动化 owner 校验，About 页面没有 UIA/截图证据；首次引导、捐赠页面和完整变更说明展示继续保持未完成。
## 2026-11-06 About 捐赠区原生接入

本批把 Electron About 页现有捐赠区迁入 WinUI 3 原生 About 覆盖页。复用 Electron 的 `donate.*` 本地化键和 8 张二维码图片，图片作为应用内容复制到 `Assets/Donate/`，不新增支付接口、不上传图片、不改变更新通道或数据目录。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| x64 Release self-contained 发布 | PASS | `build/windows-native-acceptance/about-donate-20261106/app-x64-r3/`；`publish-r3.log` |
| 捐赠二维码资源 | PASS | `donation-assets.json`；8/8 文件存在且 SHA-256 与 `src/renderer/src/features/donate/qr/` 完全一致 |
| Electron 同源软件图标 | PASS | `OpenFinalShell.ico` 由 Electron `build/icon.png` 生成并作为 `ApplicationIcon` 嵌入 PE；从 `OpenFinalShell.AboutDonateQA2.exe` 提取到关联图标 |
| About Logo / GitHub 入口 | PASS（构建级） | `Assets/OpenFinalShell.png` 随 r3 发布输出复制；About 使用 WinUI `Image` 与 `HyperlinkButton`，GitHub 地址与 Electron 设置页一致 |
| Core 合同测试 | PASS，265 项 | `core-tests.log` |
| TypeScript | PASS | `typecheck.log` |
| 本地化 | PASS | `i18n.log`；10 种语言、1324 个 key |
| About/捐赠实际 UI 自动化与截图 | BLOCKED | 当前隔离窗口仍无法通过桌面自动化 owner 校验；未发送输入、未截屏，不能标记 UI 实机验收通过 |

当前仍需在可绑定的隔离窗口中验证 About 打开、二维码显示、滚动、主题/缩放和键盘焦点；首次引导及完整 release notes 仍列为后续缺口。

## 2026-11-06 About 页面完整入口续补

本次继续对齐 Electron About 页面：原生 About 增加 Electron 同源 Logo、GitHub 仓库入口；当更新服务没有可用的发行说明 URI 时，“发行说明”按钮回退到公开 Releases 页面，而不是显示无说明占位。所有操作均通过 WinUI 原生 `Image`、`HyperlinkButton` 和 `Launcher` 完成。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| x64 Release self-contained 发布 | PASS | `build/windows-native-acceptance/about-donate-20261106/app-x64-r4/`；`publish-r4.log` |
| About Logo 资源 | PASS（构建级） | `Assets/OpenFinalShell.png` 已复制到 r4 输出；SHA-256 见 `r4-hashes.json` |
| GitHub / Releases 入口 | PASS（代码级） | GitHub 地址与 Electron 设置页一致；无 manifest 时发行说明回退到仓库 Releases 页面 |
| Native Core 合同测试 | PASS，265 项 | `core-r4.log` |
| TypeScript / 本地化 | PASS | `typecheck-r4.log`、`i18n-r4.log`；10 种语言、1324 个 key |
| About 实际 UI 自动化与截图 | BLOCKED | 当前隔离窗口仍无法通过桌面自动化 owner 校验；未发送输入、未截屏，不能标记 UI 实机验收通过 |

本批关闭 About 页面入口和资源打包差距，但不关闭首次引导或实际窗口 UI 验收缺口。

## 2026-11-06 原生发行说明续补

Electron 的 `src/renderer/src/features/onboarding/releaseNotes.ts` 已生成 104 个版本条目的共享 JSON，并嵌入 Native Core。WinUI About 的“发行说明”按钮现在优先打开本地原生滚动对话框，中文环境显示 `zh` 文案，其他语言显示 `en` 文案；只有资源缺失时才回退到 GitHub Releases。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| 发行说明资源生成 | PASS | `npm run sync:native-release-notes`；`windows/OpenFinalShell.Core/native-release-notes.json` 共 104 个版本条目，来源为 Electron `releaseNotes.ts` |
| Native Core 资源读取 | PASS | 新增 `NativeReleaseNotes`；合同测试首项验证当前版本 `0.30.34` 和至少两条说明 |
| Native Core 合同测试 | PASS，266 项 | `build/windows-native-acceptance/about-donate-20261106/core-release-notes.log` |
| WinUI x64 self-contained 发布 | PASS | `build/windows-native-acceptance/about-donate-20261106/app-x64-r8/`；`publish-r8.log` |
| 发行说明实际 UI | BLOCKED | 窗口 owner 绑定故障仍未解决，未发送输入或截图；本地对话框滚动和语言切换尚未实机验收 |

## 2026-11-06 首次运行迁移快捷入口续补

空原生数据目录的欢迎页现在显示“从 Electron 导入”快捷按钮，与连接侧栏中的迁移入口共用同一加密导入流程；检测到任意原生连接、分组、密钥、代理、known host、命令、转发或 AI Provider 后，欢迎页和侧栏快捷入口都会隐藏，避免重复引导。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| x64 Release self-contained 发布 | PASS | `build/windows-native-acceptance/about-donate-20261106/app-x64-r5/`；`publish-r5.log` |
| 首次运行迁移入口 | PASS（代码/构建级） | `WelcomeImportButton` 与 `MigrationImportButton` 均绑定 `ImportData`；空数据条件和隐藏条件复用同一实体检测 |
| 资源打包 | PASS | Logo 与 8 张二维码均存在；哈希见 `about-full-results.json` |
| Native Core 合同 | PASS，265 项 | 既有 `core-r4.log`；本批只改 WinUI 入口，无 Core 契约变化 |
| 实际首次运行 UI | BLOCKED | 窗口 owner 绑定故障仍未解决，未发送输入或截图；不能标记首次引导视觉验收通过 |

## 2026-11-06 原生首次启动 / 更新提示对齐

Electron 通过 `app:getStartupNotice` 按上次启动版本区分首次运行、版本更新和同版本启动，并只在首次读取后记录当前版本。原生版此前已有共享发行说明资源，但缺少等价的启动判定和提示入口。本批新增独立的 `NativeStartupNotice` 与 NativeStore 元数据读写：首次启动显示功能与快捷键引导，版本变化显示从旧版本到当前版本的发行说明，同版本后续启动不再重复弹出；元数据不进入用户导出数据，也不改变连接、凭据或 Electron 数据目录。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| Native startup notice contract | PASS | 首次、版本升级、同版本静默均纳入合同；`NativeStore` 元数据更新为单事务；当前 Core 合同共 271 项 |
| TypeScript | PASS | `build/windows-native-acceptance/startup-notice-20261106/typecheck.log` |
| 本地化 | PASS | `build/windows-native-acceptance/startup-notice-20261106/i18n.log`；10 种语言、1324 个 key |
| WinUI x64 Release self-contained | PASS | `build/windows-native-acceptance/startup-notice-20261106/app-x64-r1/`；日志见 `publish.log` |
| 实际启动提示 UI | BLOCKED | 隔离 WinUI 窗口仍无法被桌面自动化接口绑定，因此首次引导、更新说明滚动、键盘关闭和语言呈现尚无新的 UIA/截图证据；未操作安装版或默认数据目录 |

结构化结果：`build/windows-native-acceptance/startup-notice-20261106/startup-notice-results.json`。本批只关闭启动提示的 Core、入口和构建差距，不代表原生版已完成 Electron 全流程对齐。

补充：启动提示合同测试已覆盖关闭并重新打开数据库后的同版本静默和升级边界；当前 Native Core 为 271 项通过。



## 2026-11-06 终端命令到 SFTP 目录跟随续补

Electron 会在终端实际回显的已执行命令送达后解析 `cd`，并让 SFTP 面板按当前目录、home 目录和导航取消语义跟随；快捷命令/命令编辑器带回车时也会显式发出同一事件。原生版此前只处理 Shell 主动发送的 OSC 7，导致未配置 OSC 7 的普通 Shell 中手动 `cd`、快捷命令 `cd` 与 SFTP 面板行为不等价。

本批新增 `NativeShellPathSync`：复用原生终端已回显的 `CommandEntered`，静态解析安全的 `cd`、`-P/-L/--`、引号与首段命令分隔符，解析相对/绝对/`~` 路径后进入已有 200ms 合并、取消、会话状态和错误呈现的 SFTP 导航队列。变量、命令替换、`cd -` 和不可静态推导的目标保持原目录；未按回车的命令编辑不会触发跟随。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| NativeShellPathSync 合同 | PASS | 解析守卫、命令分隔、引号、相对/绝对/home 路径纳入 Core 合同；当前 Core 共 273 项 |
| Native SSH 合同 | PASS，49 项 | `build/windows-native-acceptance/startup-notice-20261106/ssh-tests.log`；协议、SFTP、监控和三类转发回归通过 |
| x64 Release self-contained | PASS | `build/windows-native-acceptance/startup-notice-20261106/app-x64-r3/`；`publish-r3.log` |
| 实际终端/SFTP UI | BLOCKED | 隔离 WinUI 窗口尚未能被桌面自动化绑定；普通 Shell `cd`、快捷命令 `cd`、失败提示和重连/隐藏面板行为仍需在窗口中实测 |

这项关闭了原生代码层的普通 `cd` 语义缺口，但不能把协议/合同通过当作完整 UI 等价证据。

本次合并验收：启动提示与终端 `cd` 跟随共同包含在 r3 隔离构建。当前 Core 273 项、Native SSH 49 项、TypeScript、i18n 及 x64 Release 构建通过；UI 复验仍受自动启动策略阻止。结构化结果见 `startup-notice-results.json`，本地自动启动阻断记录见 `ui-launch-blocked.log`。


## 2026-11-06 Electron 流程对齐续补：独立原生编辑器窗口

为对齐 Electron 的 EditorWindowShell，WinUI 已新增 NativeEditorWindowHost。SFTP 文件从任一会话打开后进入跨会话独立窗口；同一会话同一路径复用标签，不同会话同路径按 sessionId 隔离；最多 10 个文档。关闭标签、编辑器窗口和主窗口退出会执行保存、放弃或取消裁决；SSH 会话断开后文档保留、可复制，保存和重读禁用，重连后恢复。原有 NativeRemoteEditorService、编码/BOM/EOL、远端冲突、显著缩小和非原子替换安全闸门保持不变。

| 检查 | 结果 |
| --- | --- |
| x64 Release publish | PASS；build/windows-native-acceptance/full-parity-20261106/editor-window-x64-r2 |
| Native Core | PASS，273 项；full-parity-20261106/core-contract.log |
| Native SSH | PASS，49 项；full-parity-20261106/ssh-contract.log |
| TypeScript / i18n | PASS；full-parity-20261106/typecheck.log、i18n.log |
| UI Automation | BLOCKED；自动启动被本机策略拒绝，需手动启动后复验窗口、跨会话标签、断线草稿和关闭裁决 |

该实现仍不等于完整 Electron 功能替代；DPI、IME、普通用户、真实 Linux、RDP、AI Provider、Android 和其他架构保持原有边界。

## 2026-11-06 LAN Sync 结果回执续补

本批补齐原生版与 Electron LAN Sync 结果反馈的差距：导入完成后显示真实落库计数，发送端可读取对端 `applied` 回执中的连接、分组、代理、私钥、AI Provider、快捷命令、转发、known hosts、凭据和跳过数量。设置合并、known-host 保护、失效转发引用和失败后回到同一确认态重试也加入 Core 合同回归。

验证：Native Core 280 项通过、Native SSH 49 项通过、`npm run typecheck` 和 `npm run check:i18n` 通过，x64 self-contained 包已写入 `build/windows-native-acceptance/full-parity-20261106/lan-sync-results-x64-r3/`。最新窗口尚未取得可操作的 UI Automation 句柄，因此本项代码与合同已通过，真实窗口展示仍待手动隔离启动后复验。

2026-11-06 续验复跑确认：Native Core 280 项、Native SSH 49 项、Electron LAN Sync 集成测试 7 项、`npm run typecheck` 与 `npm run check:i18n` 均通过。当前桌面只发现 Electron 安装版窗口，最新 Native Preview r3 未运行，因此本次没有 UI Automation 或截图证据；不得把服务/协议通过外推为窗口验收通过。结构化结果 `build/windows-native-acceptance/full-parity-20261106/lan-sync-results.json` 记录了构建路径和 EXE 哈希。

本轮随后补齐了导入后的原生 UI 刷新：文件导入、LAN Sync 和 FinalShell 导入现在统一重新加载设置、连接/分组、私钥、代理、known hosts、转发、命令库和 AI Provider，并在状态栏显示实际写入/跳过计数；无需重启即可继续使用新导入内容。修复后的 x64 self-contained 构建位于 `build/windows-native-acceptance/full-parity-20261106/revalidation-20261106/app-x64-r3/`，发布日志为 `publish-r3.log`。该修复已通过编译，但仍需要在可绑定隔离窗口中做实际导入和刷新 UI 复验。

随后修正迁移默认选择：原生导入对齐 Electron，默认导入连接及其依赖、AI Provider、快捷命令、转发和 known hosts，设置类别默认不勾选；用户仍可在预览对话框中显式选择设置。Native Core 合同新增默认类别断言并达到 281 项，类别修复版 x64 构建位于 `build/windows-native-acceptance/full-parity-20261106/category-defaults-20261106/app-x64-r1/`。真实窗口中的复选框默认状态仍待 UI 复验。

## 2026-11-06 终端搜索与会话生命周期续补

原生终端搜索已按 Electron 的搜索条补齐区分大小写、正则表达式、同一行多命中、当前命中高亮、`当前/总数` 计数和上下结果导航；非法表达式或正则超时返回空结果，不阻塞终端线程。活动栏、设置和 AI 覆盖层切换时，选中的会话工作区继续保持监控采集和 SFTP 目录跟随，切换或关闭会话才停用工作区。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core 合同 | PASS，301 项 | `build/windows-native-acceptance/full-parity-20261106/revalidation-after-search-20261106-r2/core-contract.log` |
| Native SSH 合同 | PASS，49 项 | `build/windows-native-acceptance/full-parity-20261106/revalidation-after-search-20261106-r2/ssh-contract.log` |
| Renderer | PASS，1779 项通过 / 37 项跳过 | `build/windows-native-acceptance/full-parity-20261106/revalidation-after-search-20261106-r2/renderer-tests.log` |
| TypeScript / i18n | PASS | r2 `typecheck.log`、`i18n.log` |
| x64 self-contained | PASS | `build/windows-native-acceptance/full-parity-20261106/revalidation-after-search-20261106-r3/app-x64/`；结果 `results.json` |
| Native UI Automation | BLOCKED | 当前桌面可绑定窗口只有安装版 Electron，隔离 Native 窗口句柄仍未能由自动化接口取得；未操作安装版或生产数据 |

本批关闭原生代码层的终端搜索差距；完整 Windows UI 对齐仍未完成，拖放、IME、DPI/高对比度、真实 Linux/RDP/AI/Android、最终安装包及其他架构继续按矩阵单独验收。
## 2026-11-07 SFTP 原生交互续补

本批使用当前工作区源码完成 x64 隔离构建，未启动安装版或读取生产数据。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core 合同 | PASS，309 项 | `build/windows-native-acceptance/full-parity-20261107/core-after-sftp-history.log` |
| Native SSH 合同 | PASS，49 项 | `build/windows-native-acceptance/full-parity-20261107/ssh.log` |
| TypeScript | PASS | `build/windows-native-acceptance/full-parity-20261107/typecheck.log` |
| 本地化 | PASS，10 种语言、1325 keys | `build/windows-native-acceptance/full-parity-20261107/i18n.log` |
| x64 self-contained 发布 | PASS | `build/windows-native-acceptance/full-parity-20261107/app-x64/` |
| 原生 UI 自动化 | NOT RUN | 隔离 Native 窗口绑定仍不可用；未把代码/合同结果计为 UI 通过 |

本批原生 SFTP 浏览器新增 Electron 对齐的面包屑路径、返回/前进历史、拖放落点覆盖提示、单文件双击下载目标和列表表头。Explorer 拖放、面包屑点击、历史按钮、列宽/横向滚动及高 DPI 仍需隔离窗口实机复验。

## 2026-11-07 Electron → WinUI 逐流程差异矩阵

新增 [windows-native-flow-diff-20261107.md](windows-native-flow-diff-20261107.md)，按 Electron 入口、IPC/事件语义、Native Core、WinUI 入口、实际 UI 证据五层记录当前对齐状态。当前 x64 服务与构建证据保持通过；隔离原生窗口未运行，窗口层仍为 NOT RUN，不将代码或合同测试外推为 UI 通过。


## 2026-11-07 连接树键盘上下文菜单续补

为保持 Electron 连接树上下文菜单的鼠标/键盘操作语义一致，WinUI `NativeConnectionTree` 现在把菜单构建、目标捕获和动作分发统一到同一条路径：鼠标右键继续按指针位置打开，Windows 菜单键和 Shift+F10 按当前选中节点打开；虚拟化节点无法取到容器时回退到树内安全坐标。菜单项补充 AutomationName，避免 UI Automation 只能看到无语义文本。该改动只影响 WinUI 入口，不改变连接、分组或 Core 数据契约。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core 合同 | PASS，309 项 | 本轮回归输出 |
| Native SSH 合同 | PASS，49 项 | 本轮回归输出 |
| TypeScript / 本地化 | PASS | `npm run typecheck`、`npm run check:i18n` |
| x64 self-contained 发布 | PASS | `build/windows-native-acceptance/connection-tree-keyboard-20261107/app-x64/` |
| Native UI Automation | NOT RUN | 桌面清单只有安装版 Electron，隔离 Native 启动被本机策略拒绝；菜单实际位置、键盘焦点和 DPI 仍待手动窗口验收 |

程序集 SHA-256：`OpenFinalShell.App.dll` `E9DE319CD3C7B88EA4C14B6DBDC6D67CF2C27395632055079177409B9D23239F`；`OpenFinalShell.Core.dll` `20B184E9011A56878D880972C345FED0650D70E9D1668DE180751D0028F01A75`。

## 2026-11-07 SFTP 右键上传入口续补

Electron 的 SFTP 表格在空白处和目录行右键都提供上传文件、上传文件夹；原生菜单此前只有刷新/新建，上传只能通过工具栏。本批将原生菜单补齐：空白处以当前目录为目标，目录行直接以该目录为目标，文件行回退到当前目录；会话断开或目录加载中时入口禁用。上传仍走现有批量冲突规划、目录父子队列和 skip/overwrite/rename 语义。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core 合同 | PASS，309 项 | 既有 `full-parity-20261107/core-after-sftp-history.log` |
| Native SSH 合同 | PASS，49 项 | 既有 `full-parity-20261107/ssh-after-sftp-history.log` |
| x64 self-contained 发布 | PASS | `build/windows-native-acceptance/sftp-context-menu-20261107/app-x64/` |
| TypeScript / 本地化 | PASS | 本批未改 Electron/locale；上一轮 `typecheck` 与 `check:i18n` 通过 |
| Native UI Automation | NOT RUN | 隔离窗口未运行；右键菜单显示、目录行目标和文件选择器仍待窗口实测 |

## 2026-11-07 SFTP 键盘上下文菜单续补

SFTP 文件列表现在与连接树一样支持鼠标右键、Windows 菜单键和 Shift+F10。菜单打开时捕获当前选择集，虚拟化列表项无法取到容器时回退到列表安全坐标；菜单项设置 AutomationName。原有上传目标、下载、重命名、权限、删除和快速删除动作保持不变。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| WinUI x64 Release 编译 | PASS | `dotnet build windows/OpenFinalShell.App/OpenFinalShell.App.csproj -c Release -p:Platform=x64` |
| Native Core / SSH | PASS，309 / 49 | 既有本轮合同日志 |
| x64 self-contained 发布 | PASS | `build/windows-native-acceptance/sftp-keyboard-menu-20261107/app-x64/` |
| Native UI Automation | NOT RUN | 隔离窗口启动未暴露可绑定句柄；菜单焦点、坐标和文件选择器仍待实机复验 |

## 2026-11-07 原生传输队列可读性续补

Electron 传输列表会同时呈现任务摘要、源/目标路径、进度、字节计数和目录任务汇总。原生队列此前只绑定 `Summary`，虽然后端已有 `ProgressPercent`、`CompletedBytes`、`TotalBytes`、`ParentId`、`CompletedItems` 和 `SkippedItems`，界面没有展示这些字段。本批将现有字段接入 WinUI `ListView` 模板：摘要、源到目标路径、进度条和已传/总字节均可见；目录父任务的文件计数和跳过数继续由 `Summary` 呈现。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| WinUI x64 Release 编译 | PASS | `dotnet build windows/OpenFinalShell.App/OpenFinalShell.App.csproj -c Release -p:Platform=x64` |
| Native Core / SSH | PASS，309 / 49 | 当前回归合同 |
| x64 self-contained 发布 | PASS | `build/windows-native-acceptance/transfer-queue-template-20261107/app-x64/` |
| Native UI Automation | NOT RUN | 未取得隔离窗口 UIA；真实暂停/恢复、重试、父子任务视觉仍待窗口验收 |

## 2026-11-07 全流程稳定性续补

本批为全流程对齐构建增加四项原生入口与生命周期修复：活动栏新增 Electron 对应的主题切换入口；NativeSettings 接受 Electron 的 `system` 主题值；启动时缺少平台主题字典会回退而不阻止窗口创建；所有原生 `ContentDialog` 通过共享异步门控串行显示，避免会话、传输、编辑器和 RDP 回调并发弹窗导致 WinUI 异常。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core 合同 | PASS，310 项 | `build/windows-native-acceptance/full-flow-20261107/results.json` |
| Native SSH 合同 | PASS，49 项 | 本轮回归输出 |
| TypeScript / 本地化 | PASS | `npm run typecheck`、`npm run check:i18n` |
| x64 self-contained 发布 | PASS | `build/windows-native-acceptance/full-flow-20261107/app-x64/` |
| Native UI Automation | NOT RUN | 当前桌面只有安装版 Electron，隔离 Native 窗口未暴露可信 UIA 句柄；未把构建/合同结果外推为窗口通过 |

本批另修正 AI 活动栏的 opt-in 可见性：AI 未启用时隐藏会话入口，设置页仍保留配置入口；Core 的 AI feature-switch 合同继续通过。

## 2026-11-07 AI 流式/非流式响应模式

原生 AI 面板新增与 Electron 对应的响应模式选择。流式模式继续消费 SSE 增量；非流式模式发送 `stream:false`，读取 OpenAI-compatible JSON，并支持字符串或文本内容数组。两种模式都发送 Electron 使用的 `temperature: 0.7` 和 `max_tokens: 4096`。连接测试也改为向 `chat/completions` 发送非流式 `ping` 并读取完整响应，返回模型和延迟；不再用 `/models` 代替真实连接探测。图片能力探测现在要求 2xx 响应包含有效 JSON 回答，HTML 等非 JSON 响应会标为 inconclusive；明确的图片/视觉不支持错误才标为 unsupported，通用 400 错误保持 inconclusive，认证、限流和服务端错误按失败处理。同时按 Electron 的约束拒绝超过 64 条的消息，并将每条消息内容部分限制为 32 项；图片总字节限制仍使用原生 8 MiB 上限。输入限制、图片校验、取消、Token 保护和 AI 总开关保持一致。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core 合同 | PASS，318 项 | `dotnet run --project windows/OpenFinalShell.Core.Tests/OpenFinalShell.Core.Tests.csproj -c Release` |
| Native SSH 合同 | PASS，49 项 | `dotnet run --project windows/OpenFinalShell.NativeSsh.Tests/OpenFinalShell.NativeSsh.Tests.csproj -c Release` |
| TypeScript / 本地化 | PASS | `npm run typecheck`、`npm run check:i18n` |
| x64 self-contained 发布 | PASS | `build/windows-native-acceptance/full-flow-20261107/app-x64-r7/` |
| 结构化结果 | PASS | `build/windows-native-acceptance/full-flow-20261107/results-r7.json` |
| Native UI Automation | NOT RUN | 当前桌面未发现可绑定的隔离 Native 窗口；响应模式控件、发送/取消和真实 Provider 仍需实机验收 |

本批另将原生 AI 面板的发送、选图和取消按钮接入请求状态门控：运行中不能重复发送或替换图片，取消仅在活动请求期间启用，输入和 Provider 变化会即时更新发送条件；Core 仍有并发请求保护。应用 Release 编译通过，最新隔离包为 `app-x64-r7`。

原生 AI HTTP 协商也已修正：流式请求发送 `Accept: text/event-stream, application/json`，非流式和图片探测发送 `Accept: application/json`，与 Electron 的请求头语义一致。最新隔离包为 `build/windows-native-acceptance/full-flow-20261107/app-x64-r8/`，结果见 `results-r8.json`。

模型发现响应读取上限改为 Electron 对齐的 4 MiB，并在服务返回空模型列表时明确失败；通用 AI 响应仍保持 1 MiB 上限。最新隔离包为 `build/windows-native-acceptance/full-flow-20261107/app-x64-r9/`，结果见 `results-r9.json`。

AI 超时现按操作区分：聊天流式/非流式请求 120 秒；模型发现、连接测试与图片能力探测 30 秒。模型发现严格限制为 4 MiB，聊天响应按 1 MiB 限制；畸形 JSON/错误字段不会使页面解析崩溃。最新隔离包为 `build/windows-native-acceptance/full-flow-20261107/app-x64-r10/`，结果见 `results-r10.json`。

## 2026-11-07 全局传输控制续补

原生传输侧栏现提供全部暂停和全部取消。Core 只枚举顶层任务，组任务继续按子项级联；取消前展示当前可取消的队列任务数，并要求用户确认。全局操作不会重复对父子任务执行控制，列表中途清除已完成项时会跳过已消失的任务。界面文案复用共享 locale 资源。

| 检查 | 结果 |
| --- | --- |
| Native Core 合同 | PASS，321 项 |
| Native SSH 合同 | PASS，49 项 |
| TypeScript / i18n | PASS |
| x64 self-contained 发布 | PASS；`build/windows-native-acceptance/full-flow-20261107/app-x64-r11/` |
| SHA-256 App DLL | `1A32C200B42597E86C1D352B6737BDB03EA322DCBA760C54077BB519B510793E` |
| SHA-256 Core DLL | `A8ECED622CCB89C1FF855FA391E4060BCCAC4DCBA28DFF6A6D516483ED4A36F8` |
| Native UI Automation | NOT RUN；需要在隔离窗口中实测按钮、取消确认与队列状态 |

结构化结果见 `build/windows-native-acceptance/full-flow-20261107/results-r11.json`。此结果不代表全流程 UI 已验收，也未操作已安装版或生产数据。

## 2026-11-07 传输队列状态门控与下载位置

传输工具栏会根据当前选中的任务状态启用暂停、继续、重试、取消和清理。已完成下载且本地目标存在时，可直接打开目标目录或在资源管理器中选中文件；上传暂存源不暴露系统打开入口，避免完成清理后尝试打开不存在的临时文件。

| 检查 | 结果 |
| --- | --- |
| Native Core / SSH 合同 | PASS，321 / 49；此批未改动 Core/协议，沿用本轮 r11 验证 |
| TypeScript / i18n | PASS；此批复用现有 locale 键 |
| x64 self-contained 发布 | PASS；`build/windows-native-acceptance/full-flow-20261107/app-x64-r12/` |
| SHA-256 App DLL | `86D9C98913AF1F96B6D76FD390CABBABF529F2FE388AB9C1FED74024D233F39F` |
| SHA-256 Core DLL | `A8ECED622CCB89C1FF855FA391E4060BCCAC4DCBA28DFF6A6D516483ED4A36F8` |
| Native UI Automation | NOT RUN；状态门控、目录打开及资源管理器选中文件需隔离窗口验证 |

结构化结果见 `build/windows-native-acceptance/full-flow-20261107/results-r12.json`。未启动或操作当前安装版。

## 2026-11-07 传输总览与叶子任务聚合

原生传输侧栏新增 Electron 对齐的总览：完成/总任务、失败数、已传/总字节、未知大小任务、上下行速度和剩余时间。父目录任务不重复计入总览，只有叶子任务参与字节和完成统计；速度按最近进度事件采样，未知大小任务不会显示误导性的 ETA。

| 检查 | 结果 |
| --- | --- |
| Native Core | PASS，323 项；新增叶子任务聚合和空队列断言 |
| Native SSH | PASS，49 项；沿用本轮 SSH 合同 |
| TypeScript / i18n | PASS |
| x64 self-contained 发布 | PASS；`build/windows-native-acceptance/full-flow-20261107/app-x64-r13/` |
| SHA-256 App DLL | `3B7DCED0ABFB5BC0B80E5936BCA4B1D8AF72F5E96D9B5EC57A859B54A6589F3D` |
| SHA-256 Core DLL | `4A982F4D94323BEEF5EF17BAA1C6079CEFA07FF20DCBCB84C980DCE7BC1BCFAC` |
| Native UI Automation | NOT RUN；总览排版、速度、ETA 与按钮状态需隔离窗口验证 |

结构化结果见 `build/windows-native-acceptance/full-flow-20261107/results-r13.json`。未操作安装版或生产数据。

总览周期刷新续补：桌面队列每秒刷新一次速度与 ETA，传输结束后速度会归零；字节总和采用饱和加法，ETA 格式化不依赖可能溢出的 `TimeSpan` 构造。r15 x64 self-contained 发布通过，Core 323、SSH 49、TypeScript 与 i18n 检查通过。结果见 `build/windows-native-acceptance/full-flow-20261107/results-r15.json`；UIA 仍未运行。

## 原生终端 ANSI/CJK 网格

`0.30.45` 将原生终端绘制从逐 cell 背景和逐 cell 文本改为连续 span/run：

- ANSI 背景、选择区和搜索高亮各自合并连续区间，矩形边界按当前 DPI 对齐物理像素。
- 同前景色和字体样式的单格宽字符合并为文本 run；CJK、emoji 等宽字符按 libvterm 报告的 cell 数居中裁剪。
- 系统字体回退保持不变，不增加内置 CJK 字体；字体、字号、行高或 DPI 改变后重新计算 cell 网格。
- `terminal_probe` 新增中文、emoji、组合字符、方块字符、制表符和 continuation cell 断言。
- 视觉验收使用 `scripts/nativeTerminalLayoutFixture.sh`，覆盖 100%/125%/150%/200% DPI、字号 8/14/24、行高 1.0/1.2/2.0，并检查连续背景无接缝、徽标不溢出、ASCII 列保持对齐。

`0.30.46` 进一步修正文字网格：`cellWidth` 始终使用字体原始测量步进，不再向上取整；连续单格字符和连续宽字符分别形成 run。每个 run 按对应 cell span 的目标宽度进行 `0.75–1.25` 范围内的整体水平贴合，越界时保持原始比例并记录诊断。背景矩形仍独立做物理像素对齐。fixture 新增连续 `######`、长英文列、连续中文词组和多色风险条，验收重点是字符步进、词组完整性和文字/背景边界一致性。

## 2026-11-07 SFTP 表格续验（r17）

原生 SFTP 表格新增名称、大小、修改时间表头排序，始终将目录排在文件前；增加类型、权限、数字 UID/GID 和修改时间列。本轮只完成代码、Core 合同和 Release 包验证，没有得到窗口截图/UIA 树，因此不记为实际 UI 通过。Electron 会从长名称显示属主/组名；Native 当前显示 UID/GID，名称映射仍未实现。

- Core 合同：326 项通过，日志 `build/windows-native-acceptance/full-flow-20261107/core-contract-r17.log`。
- SSH 合同：49 项通过，日志 `build/windows-native-acceptance/full-flow-20261107/ssh-contract-r17.log`。
- `npm run typecheck`、`npm run check:i18n` 通过；10 种语言共 1326 个 key，检查日志分别为 `typecheck-r17.log` 和 `i18n-r17.log`。
- x64 self-contained 发布通过：`build/windows-native-acceptance/full-flow-20261107/app-x64-r17/`。结构化结果：`results-r17.json`。
- UI 自动化：未完成。隔离窗口出现在 `list_apps`/`list_windows`，但 `get_window_state` 报 `window id 329838 no longer belongs to ...; current owner is ...`；没有对窗口执行交互。

