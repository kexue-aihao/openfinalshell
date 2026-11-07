# Windows native migration status

更新日期：2026-11-06。范围：Windows 11 Pro Build 26300 x64，管理员会话，本机 fixture。

2026-11-06 Electron 导出兼容续补：原生 `ExportEnvelope` 现在同时接受 Electron v1（明文配置、可选加密凭据块）和 v2（整包加密）格式。v1 无凭据时不会要求口令；含凭据时仅解密 `secrets` 块，随后按原有事务、备份和本机 DPAPI 重存逻辑导入。错误口令、损坏信封、超出 Electron 安全范围或非 2 次幂的 KDF 参数、未知版本均在写库前拒绝；有界合法旧 scrypt 参数可正常解密。Core 兼容合同达到 293 项，Native SSH 49 项、Electron 迁移定向测试 45 项、TypeScript/i18n 通过；x64 隔离包为 `build/windows-native-acceptance/electron-v1-import-20261106/app-x64/`，EXE SHA-256 为 `52EA43D095D07931CB44550A6F02D7166309DF716C1FDED5CB3490E50847B050`。窗口导入 UI 仍需在可绑定的隔离窗口中复验。

2026-11-06 默认交互语义续补：原生设置面板和 SFTP/终端运行时现在共享 Electron 默认值：显示隐藏文件、双击下载、终端右键粘贴、选中即复制；显式保存值仍优先，未知值回退到同一安全默认。Core 合同达到 296 项，Native SSH 49 项，x64 隔离构建见 `build/windows-native-acceptance/sftp-terminal-defaults-20261106/`；窗口内设置控件与真实 SFTP/终端交互仍待 UI 复验。

2026-11-06 终端搜索与会话保持续补：原生终端搜索现在支持 Electron 对齐的区分大小写、正则表达式、同一行多命中、当前命中高亮、上一个/下一个和 `当前/总数` 计数；非法或超时正则安全返回空结果。活动栏、设置和 AI 覆盖层切换时，当前会话的工作区不再被错误停用，监控与终端目录跟随继续保持，只有切换/关闭会话才停用。Native Core 合同 301 项、Native SSH 49 项、Renderer 1779 项通过；x64 隔离包见 `build/windows-native-acceptance/full-parity-20261106/revalidation-after-search-20261106-r3/app-x64/`。真实窗口 UI 仍受隔离 Native 进程绑定问题阻断。

2026-11-05 工作台重排：活动栏/上下文侧栏/主会话区/状态栏和设置、AI、LAN Sync 覆盖面板已实现；响应式侧栏代码已编译，Core 190 项、typecheck、i18n 通过。用户于 2026-11-06 重启最终 x64 隔离窗口，但新窗口 ID `11669444` 在刷新应用清单后仍无法由自动化工具绑定，未进行 UI 操作或截图；故状态为“排版代码与构建通过，UI 复验受窗口绑定错误阻塞”，不宣称功能已与 Electron 对齐。详见 [windows-native-acceptance.md](windows-native-acceptance.md) 与 `build/windows-native-acceptance/layout-reflow-final-20261105/layout-results.json`。

完整对齐复审：**尚未完成完整迁移，不能替代 Electron 0.30.34。** 逐项服务、入口、行为和实测状态见 [windows-native-parity-status.md](windows-native-parity-status.md)。原有“代码完成”表述已改为局部实现，保留协议证据的适用范围。

| 领域 | 状态 | 当前实现与验收 |
| --- | --- | --- |
| WinUI shell | 工作台已接入，排版重构构建通过、UI待验收 | 新增连接树、搜索、快速连接、最近会话、同屏终端/SFTP/编辑器/监控；工作台已改为活动栏/上下文侧栏/会话区/状态栏，完整入口/快捷键/布局验收仍未关闭 |
| 设置与迁移 | 持续补齐、部分 UI 待验收 | 新增 Electron 同款八色强调色选择并应用于 Fluent Accent 资源；下载目录路径新增系统文件夹选择器；新增 FinalShell 目录扫描、层级预览和 skip/duplicate 导入；原生工作区新增窗口尺寸/最大化状态恢复；设置覆盖层新增 About/同源 Logo、GitHub、Releases 回退和 104 条本地发行说明。当前 Native Core 301 项、隔离 x64 Release 构建通过；窗口绑定仍失败，色板、Picker、FinalShell、About 和窗口恢复均未取得新的 UI 截图证据 |
| SSH Agent | 代码完成，协议通过 | SSH_AUTH_SOCK、Windows OpenSSH Agent、Pageant 身份和签名帧测试通过 |
| 会话与跳板机 | 代码完成，fixture 通过 | 密码/KBI、独立 host-key、单跳、缺失/嵌套引用错误；真实服务器矩阵待测 |
| Terminal | 部分对齐 | 主题/字体/缓冲/菜单及 TSF 输入客户端已接入；历史改从远端回显采集，拒绝口令提示与全屏程序；真实 IME/Narrator/DPI/多屏及重排待测 |
| SFTP | 部分对齐 | 路径/隐藏/排序/多选菜单/默认下载目录已接入；OSC 7 目录跟随与请求合并已接入；批量上传冲突规划按 Electron 的 ask/overwrite/skip/rename 对齐，skip 已进入独立队列终态；下载批量文件采用验证后同名替换、目录合并；未设默认目录时单项/多项统一选择目标文件夹。26 项最新 fixture smoke 覆盖本地已存在目标时的字节一致性；Picker 实际 UI、Explorer 冲突 UI、真实拖放、packed transfer、快速删除、不发通知 Shell 的目录跟随及完整 UI 矩阵仍未完成 |
| Transfer queue | 部分对齐，合同与 fixture 通过 | 文件/目录父子任务、进度、跳过汇总、慢速暂停/恢复、失败重试/取消和字节校验通过；下载同名目标替换/目录合并对齐 Electron worker，26 项最新版 SSH/SFTP fixture smoke 覆盖现有本地目标替换与字节校验；长目录及队列 UI 待实测 |
| Scintilla/Lexilla | 部分对齐 | owned HWND 显示、fixture 输入/保存实测；查找替换/跳行/折叠/语言/wrap/缩进已接入，同会话多文档存在；编码重解码/严格无损/BOM/EOL 状态已接入；真实目标保护和权限转换协议通过；独立窗口已接入跨会话标签、断线草稿保留与关闭裁决；最新窗口实机交互和大文件性能待补 |
| Monitoring | 仪表盘已接入，fixture 局部复验 | CPU/内存/网络卡与双序列趋势、逐核/磁盘/进程/socket 列表；隐藏取消与快照代次保护已接入，真实 Linux/权限/重连待验收 |
| Forwarding | 代码完成，协议通过 | local/remote/dynamic 实际回环、活动连接、双向字节、停止清理；UI basic pass |
| RDP | 外部阻断 | FreeRDP runtime DLL 缺失，真实服务、音频和拖放未验收 |
| AI | 服务与配置入口补齐，UI待验收 | AI 总开关、Provider 清 Token/删除、事务化凭据清理、旧配置合并与加密迁移类别已接入；关闭开关时阻止网络操作。当前 Native Core 总计 280 项。原生 AI 操作 UI 未取得截图；真实 Provider 未测 |
| Command library/history | 部分对齐 | 新增搜索、移动排序、显式多会话发送、占位符和无回车历史回填；qa20 验证已保存的多行命令重新打开仍保留两行，自动回车关闭；编辑保留未知字段/顺序/原始空白，完整发送与历史流程 UI 待补 |
| LAN Sync | 代码与协议通过，窗口待验收 | 本机配对/加密交换、实际导入计数、settings 局部合并、known-host 保护、失效转发跳过和失败后重试均已接入；Native Core 280 项、Native SSH 49 项和 Electron LAN Sync 7 项通过。最终隔离窗口流程仍未实测；Electron/Android 和真实网络互操作未测 |
| 导入后状态刷新 | 已补齐，窗口待验收 | 文件导入、LAN Sync 和 FinalShell 导入统一刷新连接/分组、设置、密钥、代理、known hosts、转发、命令库和 AI Provider，并在状态栏显示实际写入/跳过计数；修复版 x64 构建已通过，实际窗口导入与刷新仍待 UI 复验 |
| 迁移默认类别 | 已与 Electron 对齐，窗口待验收 | 默认选中连接及依赖、AI Provider、快捷命令、转发和 known hosts；settings 默认不选，用户可显式勾选。Core 合同达到 281 项，类别修复版 x64 构建通过，复选框实际呈现仍待 UI 复验 |
| FinalShell import | Core 与入口已接入，UI待验收 | 专用扫描识别 `conn/*.json`、嵌套分组、SSH 编码与锁定密码提示；事务导入保留层级，skip/duplicate 可选。FinalShell 密码不猜解；真实目录格式和 UI 流程待验 |
| Multi-window | 部分实现 | 单实例写者、聚焦和 CAS 通过；NativeEditorWindowHost 已提供跨会话独立编辑器窗口，窗口 UI 复验待补 |
| Update/install | 部分实现 | 校验门控和中断记录合同通过；签名、UI、覆盖升级和回滚未测 |
| Electron 右键菜单 | 代码完成，组件通过 | body portal、viewport 夹取、统一关闭监听、键盘导航和目标保持已实现；DPI/玻璃实机矩阵待测 |
| Electron → WinUI 迁移入口 | 代码完成，本机 x64 通过 | 设置卡片、加密导出二次口令、架构清单下载/哈希校验、安装器启动、离线已安装启动及原生首次导入入口已验证；Authenticode、x86/ARM64 真机待测 |
| Accessibility/platform | 部分实现 | UIA 名称/实时区域已接入；完整键盘、Narrator、高对比度、DPI 和 Windows 10 未测 |
| Auxiliary pages | 入口已接入，窗口待验收 | About 页面已接入版本、环境、更新检查、104 条本地发行说明、GitHub/Releases 入口、Electron 同源 Logo 和 8 张捐赠二维码；NativeStartupNotice 已实现首次运行引导、版本更新说明和同版本静默。实际弹窗视觉、滚动、关闭和语言呈现仍待 UI 复验 |

当前不能把 Windows 原生版标为正式替换。阶段完成条件是矩阵中所有 `部分实现`、外部阻塞和平台缺口关闭；Electron 继续作为正式 Windows 客户端。

本批 qa19 构建成功：Core 190、SSH 49、Smoke 24、Renderer 16、Electron SFTP 18 项通过。qa19/qa20 已完成部分实际 UI 复验，qa20 的多行命令编辑回显修复通过；2026-11-06 冲突规划、跳过队列、FinalShell 导入、窗口状态、About、Logo、GitHub/Releases、本地发行说明和捐赠区入口续补后，当时 Native Core 为 266 项；后续当前总计 273 项通过，x64 Release 发布成功。完整最终 UI 矩阵仍未完成。详见验收文档与 `build/windows-native-acceptance/about-donate-20261106/`；仍不满足完整对齐或正式替代门槛。


2026-11-06 独立编辑器窗口续补：NativeEditorWindowHost 已实现 Electron EditorWindowShell 的原生等价入口。文档键为 sessionId + 远端路径，跨会话同路径不会串线；断线保留文档草稿并禁用保存/重读，重连后恢复；关标签、关编辑器窗口和退出主窗口均执行保存/放弃/取消裁决。 最新隔离包：build/windows-native-acceptance/full-parity-20261106/editor-window-x64-r2。Core 273、SSH 49、typecheck、i18n 和 x64 publish 通过。UI Automation 因本机执行策略阻止自动启动，仍需用户手动启动该隔离包。
