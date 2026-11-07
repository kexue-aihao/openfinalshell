# WinUI 3 / Electron 用户流程差异与验收状态

基线：本机 Electron 与 Native Preview 均为 0.30.34。基线日期：2026-11-04；UI 续验更新：2026-11-05；AI 迁移、SFTP、Electron v1 导入兼容与默认交互续补：2026-11-06。源码目录以 `src/renderer/src/features/`、`src/main/ipc/`、`src/shared/types.ts` 为对照；原生实现位于 `windows/`。本表替代旧矩阵中将“协议通过”解释为“功能对齐完成”的结论。

“已接入”只表示存在代码与入口。完成必须同时有服务、入口、正确交互和实际证据。合同/fixture 不代表真实服务验收；未测不能标为通过。Windows 11 Pro Build 26300 x64、管理员会话；隔离数据与回环 fixture；现有安装和生产数据未替换。

2026-11-07 续验说明：最近的 `full-flow-20261107` 构建增加了主题切换入口、`system` 主题兼容、主题资源启动回退和 ContentDialog 串行门控；r17 进一步增加 SFTP 表头排序与 UID/GID 列。隔离窗口由用户手动启动并出现在桌面清单中，但 Computer Use 读取仍报窗口 ID 与报告的 owner 不匹配，未取得截图或 UIA 树；以下“UI 待测/外部阻塞”结论不因构建通过而改变。

## 第一批：数据兼容与工作台

| Electron 流程 / 对照 | 服务实现 | 界面入口 | 交互等价 / 剩余缺口 | 实际验收证据 |
| --- | --- | --- | --- | --- |
| 嵌套分组、移动、删除：connections / conn IPC | parentId、循环/缺失检测、删除提升子组和连接、未知字段保留 | 原生树、父组编辑、归组拖放、移到根目录 | 已接入；树拖放与所有冲突路径需 UI 复验 | Core 合同通过；隔离树呈现两层嵌套 |
| 连接搜索、展开状态、排序、分组 | 按名称/主机/用户过滤；展开状态独立保存 | 侧栏树与搜索框 | 已接入；搜索清除、键盘和重启恢复需完整复验 | 树与重启展开状态已观察；搜索/拖放待测 |
| 主机打码、标记、连接/组菜单 | 共享 connection.maskHostInList、flag | 原生 MenuFlyout 捕获目标 | 已接入；不能只验菜单可打开 | 已观察打码；菜单目标及四角矩阵待测 |
| 快速连接、最近会话 | 临时 SSH profile、连接时间排序 | 欢迎页 | 已接入；快速连接真实登录提示待测 | 最近会话重启仍在；生产主机未连接 |
| follow/direct/custom 代理 | 全局默认、saved→custom、旧未指定模式保持直连 | 设置默认代理、连接编辑器 | 缺失引用返回错误；全局变更不重写连接 | Core 合同通过；代理设置 UI 待完整复验 |
| 完整连接字段 / conn、savedRefs IPC | SSH Agent、字符集、跳板、压缩、兼容算法、RDP 共享字段 | 连接原生表单 | 保留未知字段；缺省分组可显式清空 | Core/SSH 局部通过；表单保存重启字段往返待测 |
| 设置局部保存 / settings IPC、AppSettings | 深层 patch、兼容旧字段、类型容错、未知字段保留 | 原生设置分类；新增八色强调色选择器并实时映射 Fluent Accent 资源 | 常规/外观/终端/传输与监控选项已有入口；不代表全部设置齐全 | Core 合同覆盖强调色加载、并发局部保存、加密导出与非法值回退；accent-parity x64 构建通过；本轮窗口未启动，色板显示与实时视觉效果待 UI 复验 |
| 活动栏、状态栏、会话工作区 / layout、sessions | 会话独立持有终端、文件、编辑器、采集器 | 同屏分区、导航 | 导航不销毁会话；分隔权重独立保存 | qa13 观察过同屏与切设置后状态保持；2026-11-05 重排构建通过。新活动栏布局的 UIA/截图仍待复验，见 `layout-reflow-final-20261105/layout-results.json` |
| 工作台响应式排版 | WinUI Grid、原生标题栏、上下文抽屉 | 活动栏、上下文侧栏、会话工作区、状态栏、设置/AI/LAN Sync 覆盖层 | 现有入口保留；极窄宽度侧栏抽屉、侧栏限宽和状态保持已接入 | x64 Release 构建通过；用户重启隔离构建后，新窗口 ID `11669444` 仍在刷新应用清单后绑定失败，报出的 owner 与目标进程相同；无 UI 操作/截图证据。尺寸、缩放、主题/语言矩阵未测，不标排版验收通过 |
| 可收起监控与采集生命周期 | 隐藏/断线停止、重新展示重置计数、拒绝旧快照 | 同一会话右侧 | 已接入；重连/切会话竞态需压测 | SSH 合同验证 Start/双 Stop/重启/取消和停止后无快照；qa13 fixture UI 局部通过，最终 UI 待补 |
| 加密导入类别、预览、冲突、备份 / app IPC | v1（明文 data + 可选 scrypt/AES-GCM secrets）与 v2（整包 scrypt/AES-GCM）均解析；事务、依赖检查、按类别重写重复 ID；AI Provider 元数据纳入类别选择 | Electron 文件导入/LAN Sync 与原生迁移入口；连接侧栏和空欢迎页均提供首次运行迁移快捷入口；新增 FinalShell 目录扫描/预览/冲突入口 | 未选类别不写入；v1 无凭据文件无需口令，含凭据或 v2 才提示口令；AI Token 只在用户勾选“包含已保存凭据”并输入导出口令时进入加密 secret map，导入后重存本机 Vault。FinalShell 密码不猜解，首连时重新询问；存在任意原生实体后首次运行快捷入口自动隐藏 | Electron 导入/加密/LAN Sync 测试通过；Native Core 293 项与 Electron v1/v2 夹具通过；x64 隔离发布见 `build/windows-native-acceptance/electron-v1-import-20261106/`；完整原生 UI 导入重启和真实 FinalShell 样本待测 |
| 数据目录、DPAPI、smoke 数据保留 | 正式目录不变，测试覆盖需显式 test mode | 隔离构建标题标明 isolated test | 不直接读写 Electron SQLite，不自动删除旧连接 | 当前隔离数据与 fixture；未修改安装版数据 |

## 第二批：终端、文件、编辑器

| Electron 流程 / 对照 | 服务实现 | 界面入口 | 交互等价 / 剩余缺口 | 实际验收证据 |
| --- | --- | --- | --- | --- |
| SSH 三种 Agent、单跳、五种编码 / session、term IPC | 保留现有协议能力、重连恢复终端尺寸和 SFTP | 连接设置/会话 | 已实现；真实系统 Agent 与真实跳板资源另验 | 2026-11-06 Native SSH 合同 49 项通过；不是全部真实服务验收 |
| 认证、host-key、错误、断线、输出背压 | 有界输出队列、独立 host-key、取消后不复活 | 原生提示/状态 | 重连与会话关闭测试已增强 | SSH fixture 通过；生产凭据未使用 |
| 终端主题/字体/光标/缓冲/缩放 | 主题资源、字形宽度、scrollback ABI、保留 resize 历史 | 设置与终端菜单 | 原生 Win2D/libvterm 等价 WebGL；不提供无效 WebGL 开关；重排尚不等价 | native probe 局部通过；多字体/DPI/长输出需 UI 复验 |
| 复制/粘贴/选择/搜索/命令历史 | 原生选择、剪贴板、多行粘贴确认、历史开关 | 右键、Ctrl+F、Ctrl+Shift+H、设置 | 已接入；终端快捷键冲突、历史清除与隐私矩阵需补 | 历史合同局部；完整键盘 UI 待测 |
| 中文 IME composition / TerminalPane | 新增 WinUI TextBox TSF 输入客户端，预编辑不发往 SSH | 光标位置的原生输入表面 | 新实现待真实输入法复验；不能标通过 | 构建通过不代表中文输入验收 |
| SFTP 路径、隐藏、排序、多选、菜单 / sftp IPC | 目录优先排序、筛选、多选 chmod/删除预览、目标捕获 | 工具栏、原生菜单、Enter/F2/Delete/F5；名称/大小/修改时间表头排序；类型、权限、UID/GID 和时间列 | 代码新增可点排序和 UID/GID 可见性；Electron 显示属主/组名，Native 当前只有数值 ID，仍有显示差异；表格/批量 UI 待最终实测 | Core 326、SSH 49 和 r18 x64 发布通过；表头/行同步横向滚动；本轮 UIA 读取失败，排序点击、列宽及多选 UI 未实测 |
| 文件/目录拖放上传、目标目录识别 | 归一化目标、文件暂存、链接/深度/数量保护 | SFTP Drop | 已接入；管理员环境 Explorer 拖放限制需区分 | 历史协议 smoke；本轮真实拖放待测 |
| 传输并发、冲突、父子进度、重试、取消 / transfers | 可动态调整全局/会话额度、目录任务、ask/skip/overwrite/rename、全局暂停/取消、完成下载后打开本地目标位置、总览速度与 ETA | 设置、队列、冲突对话框、已完成下载位置操作、队列总览 | 文件选择、目录选择和拖放上传统一批次探测；一次性覆盖/跳过/重命名，目录冲突按顶层目录裁决；跳过项作为独立 `Skipped` 任务，目录父项汇总跳过数；下载后可在资源管理器中定位文件或打开目录；队列控制按钮按任务状态门控；总览按叶子任务计算完成/失败/字节/未知任务/上下行速度/ETA。新上传 UI 真实点击及拖放仍待复验 | Core 323 项、SSH 49 项与 x64 Release 通过；总览显示、全局控制、状态门控、资源管理器定位仍待隔离 UI 实测 |
| 下载目录偏好与目标选择 | Electron 设置 downloadDir；未设置时单项/多项均选择目标目录 | 设置中的原生目录浏览器与 SFTP 下载目标选择 | 已接入手动路径和系统 FolderPicker；无默认目录时单项和多项均弹 FolderPicker；目标文件落地按队列验证后替换 | 历史 qa13 默认目录下载回读 SHA-256 一致；本批 x64 构建通过；新设置目录浏览按钮未做实际窗口操作 |
| 打包传输 | SFTP 目录下载启发式探测，远端单 tar、本机校验解包；不支持上传打包 | SFTP 目录下载入口，设置中可开启 `sftp.packedTransfer`；条件不满足时进入父子逐文件队列并显示回退原因 | 已接入原生队列；tar 只读探测、空间/文件数/冲突判定、阶段状态、临时包生成/下载/清理、Windows 路径和设备名校验已实现。暂停/取消在打包阶段边界生效，传输阶段可中止；恢复时重新打包。实际远端 tar 命令和队列全链路仍待 Linux/fixture UI 验收 | 223 项 Core 合同通过（含探测、回退、shell 引号、生成临时路径约束、字节解包、路径穿越/多顶层/ADS/设备名/大小写冲突拒绝）；x64 Release 构建通过；UI 与真实 Linux 仍未验收 |
| 受保护快速删除 | 直接执行有路径守卫的分批 `rm -rf` | SFTP 右键，仅目录选择且受 `sftp.fastDelete` 设置控制；确认框展示命令 | Native Core 重验绝对路径、控制字符、`.`/`..`、最小路径深度，POSIX 引号、64 项/命令长度分批；有残留、非零退出和断线未知结果呈现。行为语义按 Electron 对齐 | Core 新增合同通过；x64 Release 构建通过；最终 UI/真实 Linux shell 验收待完成 |
| 终端目录跟随 / sftp.followTerminalCd | 新增有界 OSC 7 解析，并对齐 Electron 的已执行命令事件 | 原生设置及同屏 SFTP，普通 Shell `cd`、快捷命令带回车、OSC 7 均进入 200ms 合并队列；变量/`cd -` 保持不跟随 | 代码和合同已覆盖；实际 UI、失败提示、隐藏/断线/重连矩阵待测 | Core 280 项、SSH 49 项通过；最终窗口仍待自动化绑定 |
| Scintilla/Lexilla 可见性与主题 / editor IPC、cmSetup | WinUI 合成层上使用 owned native popup、随布局与弹窗隐藏 | 同一会话内多文档 | 已修复空白表面；输入焦点/弹窗/缩放必须复验 | qa13 文本/行号/查找选区与导航返回保持已观察；qa19 待复验 |
| 查找替换、选项、跳转行、折叠、语言 | 原生 Scintilla search/regex/replace target、Lexilla、定位 | 编辑器工具条 | 已接入；复杂正则/零长度与撤销需复验 | qa13 查找命中 fixture 文本；复杂替换/撤销等仍待测 |
| 编码/BOM/EOL、二进制/大文件/远端冲突 | 严格无损转换、GB18030 CP54936、10 编码、主导 EOL/mixed 检测；真实目标基线与权限保留 | 编码选择、BOM/EOL 状态、mixed 警告；远端冲突/大幅缩减/非原子回退单独确认 | 已接入 wrap/缩进；symlink 改指或变目录拒绝保存。SFTP 检查与替换间不提供远端写者 CAS 保证，真实 Linux mode/ACL/owner 另验 | qa14 无 BOM 重解码未丢字节；Core/SSH/Smoke 验证编码和保存；qa19 交互待复验 |
| 独立编辑器窗口、跨主机同路径 | 每个 session workspace 分离文档身份 | NativeEditorWindowHost 跨会话文档标签 | 已接入独立原生窗口、最多 10 个文档、断线保留草稿及逐文档关闭裁决；最新窗口 UI 待复验 | x64 full-parity-20261106 构建通过，Core 280/SSH 49/typecheck/i18n 通过 |

## 第三批：运维工具

| Electron 流程 / 对照 | 服务实现 | 界面入口 | 交互等价 / 剩余缺口 | 实际验收证据 |
| --- | --- | --- | --- | --- |
| CPU/逐核/内存/负载/网络 / monitor IPC | Linux /proc 解析和增量 | 新增指标卡、双序列趋势、接口明细 | 已接入 90 点有界历史；图例/时间轴/选择细化待做 | parser 合同；qa13 dashboard fixture 卡片/趋势/明细已观察；真实 Linux 外部阻塞 |
| 磁盘容量/I-O、进程、socket/TCP、延迟 | 结构化 snapshot 已有 | 展开明细列表、延迟卡 | 已接入；权限/错误/重连场景待测 | fixture 不能代替真实 Linux |
| 端口流量 / portTraffic IPC | ss 解析、周期采样 | 会话入口及列表 | 需真实权限和端口负载验收 | 外部阻塞；不能宣称生产通过 |
| local/remote/dynamic / forward IPC | 规则、遥测、停止清理、自动启用 | 原生规则页面/会话目标 | 基础闭环存在；规则编辑、归属、异常 UI 仍需逐项复验 | 协议回环/字节局部通过；全部 UI 未验完 |
| 命令库 / snippet、history IPC | CRUD、搜索、分组排序、发送、历史、占位符；保留未知字段 | 原生页面、临时多行编辑、显式多会话目标、Ctrl+Enter、另存为命令 | 多行编辑回显修复已在 qa20 实际复验；完整多目标/历史流程仍待复验 | qa19 重现多行截断；qa20 重开后两行均显示，自动回车仍关闭并取消退出；证据见 `final-ui-qa19-20261105/21-qa20-multiline-fixed-*` |
| AI Provider、模型、流式、取消、图片 / ai IPC | 有界 HTTP/SSE、图片、端点约束；兼容旧 aiProviders 和 aiProfiles；设置支持总开关、配置保存/删除、Token 清除、连接/图片能力测试和模型发现 | 原生设置总开关、Provider 配置/清 Token/删除、AI 对话页面；Markdown 围栏代码块复制、SSH 目标选择、整块与逐行填入 | 服务和入口已补齐；关闭总开关时 Core 拒绝模型发现、连接/图片测试和对话，界面禁用对应发送/测试控件但保留配置管理。凭据替换、清除、删除按事务更新；共享引用仍在使用时保留 secret。代码块填入继续受 bracketed-paste 和安全限制。共享加密迁移现已包含 AI Provider 与按类别导入；完整 UI 操作和真实 Provider 尚未验收 | AI/凭据批次 Core 265 项合同与 x64 Release 构建通过；UI Automation 绑定窗口 `11669444` 报 owner mismatch，未操作/截图；真实 Provider 外部阻塞 |
| AI 配置迁移格式 | Electron `exportData` 读取 `ai_profiles` 并规范为 `aiProfiles/apiKeyRef`；含密钥导出时把 Token 明文只暂存于共享密钥映射并随 v1/v2 加密，导入端按选择重新写入 Vault；LAN Sync 复用相同 envelope | Electron 文件/LAN 类别选择；WinUI 原生已有 `aiProfiles` 导入与 `apiKeyRef` 解引用，并在原生迁移预览统计 AI Provider | 已补齐共享格式和冲突策略：Token 不导出为明文或 DPAPI 密文；无 Token 文件不会制造外来悬空引用；覆盖无 Token 配置会清除旧 Token，未包含密钥的同 ID 导入保留本机 Token，重复策略创建独立 Token；AI 冲突预览独立提示 | 2026-11-06 Electron 全套测试 1779 passed/37 skipped；typecheck、i18n、导入/加密/LAN Sync 定向测试通过；Native Core 240 项与 NativeSmokeRunner 24 项通过，隔离 x64 Release 发布成功。窗口 `11669444` 两次绑定均报 owner mismatch，原生 AI 导入实际 UI 仍待复验 |

## 第四批：平台与发布

| Electron 流程 / 对照 | 服务实现 | 界面入口 | 交互等价 / 剩余缺口 | 实际验收证据 |
| --- | --- | --- | --- | --- |
| 全部设置/即时生效、主题、强调色、语言 | 部分设置已接入、10 种语言 | 原生分类与主题/语言选择；本批新增共享八色强调色控件及实时 Fluent 色刷更新；原生工作区保存并恢复有效窗口尺寸与最大化状态 | 强调色和窗口状态已实现；剩余设置分类与验证提示待补 | Native Core 280 项合同与 x64 build 通过；新色板/FolderPicker/FinalShell 入口及窗口恢复仍未取得实际窗口验收 |
| 全局快捷键与帮助 / shortcuts.ts | Ctrl+Shift+T、Ctrl+W、Ctrl+Tab/Shift+Tab、Alt+1…9；XAML/Scintilla 共用仲裁、IME/modal 保护 | 设置快捷键帮助；终端/文件保留局部快捷键 | 文本框/编辑器 Ctrl+W 保留文本语义；无选区 Ctrl+Shift+C 不再误发 Ctrl+C；全部焦点组合待复验 | Core 仲裁合同及 qa19 编译通过，实际新 UI 未验收 |
| 标签/窗口关闭与活动任务保护 | 会话/传输/转发/脏编辑器裁决 | 原生确认框 | 已接入；并发弹窗序列化和退出恢复待测 | qa14 退出确认已观察并正常关闭；qa19 并发快捷键关闭待复验 |
| FinalShell 专用迁移 / app IPC | 扫描 `conn/*.json`、SSH/分组预览、skip/duplicate、密码/代理/密钥/转发提示 | 原生设置增加 FinalShell 目录选择、预览、冲突选择和导入结果对话框 | 已接入 Native Core；FinalShell 自有密码保持空值并提示首次输入；代理/密钥/转发只提示不伪造引用；实际 UI、真实 FinalShell 数据目录和复杂旧格式待测 | Core FinalShell 合同通过（总合同 259 项）；x64 Release 构建通过；新隔离窗口未启动，UI 未截图 |
| LAN Sync / sync IPC | 原生配对、加密协议、按类别/冲突策略导入及结果回执 | 原生页面 | 实际计数、settings 合并、known-host 信任保护、失效转发跳过和失败后可重试已补；接收/发送窗口流程仍待复验 | Native Core 280 项、Native SSH 49 项、Electron LAN Sync 7 项、typecheck/i18n、隔离 x64 发布通过；Electron/Android 真实网络互操作仍待外部设备 |
| 多窗口 / editor IPC | 单实例与写者协调已有 | NativeEditorWindowHost 原生独立编辑器窗口 | 跨会话标签、关闭裁决和断线草稿保留已接入 | 隔离 x64 构建通过；窗口 UI 待复验 |
| 首次引导、更新说明、捐赠、关于 | 部分 release notes/update 信息 | 设置覆盖层新增原生 About 页面，显示版本、环境、更新检查、变更说明、GitHub 入口和 Electron 同源 Logo；About 内加载 Electron 同源 8 张捐赠二维码及本地化说明和 104 个本地发行说明条目；启动时按版本显示首次引导或更新提示，同版本静默；资源缺失时回退到 Releases 页面；原生 PE 使用 Electron 同源图标 | About/捐赠/更新入口和启动判定已接入；实际弹窗视觉、滚动和语言切换待 UI 复验 | `startup-notice-20261106/app-x64-r1` x64 构建通过；Core 271、typecheck、i18n 通过；窗口 UI 绑定失败，About 与首次启动提示尚无新的实机 UI 证据 |
| RDP / rdp IPC | Worker 接口及表面存在 | 连接入口存在 | FreeRDP runtime 打包及嵌入/输入/缩放/证书/音频/剪贴板/文件仍未完成完整验收 | qa19 Worker 自检退出 0xC0000135/无 HELLO；stage manifest=optional，严格打包失败；真实 RDP 服务外部阻塞 |
| 安装/签名清单/校验/退出/升级/恢复 / update IPC | 现有独立原生更新器，校验与活动任务保护 | 设置更新区域 | 最终安装包复验、签名发布、失败恢复需继续 | 历史协议证据保留；本批未安装、未发版 |
| DPI/高对比度/明暗/IME/尺寸/权限/架构 | 原生布局与 UIA | 系统与应用设置 | 本轮只测应用内缩放；不可冒充 OS DPI 测试 | OS 100/125/150%、Narrator、普通用户、x86/ARM64 待测 |

## 构建与结果

证据目录：`build/windows-native-acceptance/parity-batch1-20261104/`。每个 `app-qa*` 为独立自包含 x64 开发验收构建，版本仍为 0.30.34；`NativeAcceptanceName` 区分测试进程，不覆盖安装版。最终验收构建路径和结果以该目录 `parity-results.json` 为准。

当前是“逐领域实现与局部复验进行中”。2026-11-05 工作台重排代码和构建检查通过；已启动的隔离窗口仍无法由自动化接口绑定，接口报告窗口与同名进程归属校验失败，因此没有新的 UI 操作或截图证据。2026-11-06 强调色、下载目录设置、FinalShell 导入、窗口尺寸恢复、About 发行说明和启动提示、终端目录跟随、独立编辑器窗口、LAN Sync 回执、Electron v1/v2 导入、SFTP/终端默认交互和终端搜索对齐的 x64 构建通过；最新 Native Core 301 项合同、Native SSH 49 项和 Electron LAN Sync 7 项测试通过。第二至四批缺口必须继续关闭，不满足完整替代/正式发布条件。历史文档中的计数与“代码完成”仅代表当时局部证据，不能推导本表中未完成项已经通过。

## 2026-11-06 SFTP 批量上传冲突对齐

文件选择、目录选择与 Explorer 拖放上传现统一走一份顶层批次冲突规划：按 Electron 的 `ask / overwrite / skip / rename` 语义，对整批只询问一次；重命名采用 `name (2).ext` 并预留已存在与本批选中的名称；覆盖拒绝文件/目录类型不匹配及符号链接；无法列出远端目录时停止入队并显示检查错误。目录覆盖继续以顶层目录为裁决单位，既有子文件仅在用户选择覆盖后替换。下载多选仍逐项询问。上传跳过项的队列展示已于 2026-11-06 后续批次补齐，见下方验收续记；该历史批次的结论不包含此修复。

Core 新增 8 项纯规划合同并通过，x64 自包含 Release 构建通过。隔离 UI 尚未针对冲突对话框、拖放和真实点击复验；这项只关闭批次策略实现差距，不标记完整 SFTP 验收通过。结构化结果和复现步骤见 `build/windows-native-acceptance/batch-upload-conflict-20261106/`。

## 2026-11-04 本批交付快照（qa19）

- 自包含 x64：`build/windows-native-acceptance/parity-batch1-20261104/app-qa19/OpenFinalShell.ParityApp.exe`，版本 0.30.34。它是开发验收输出，不是最终安装包，不覆盖安装版。
- 当前检查：Core 190 项、SSH 49 项、NativeSmokeRunner 24 个断言、Electron SFTP 18 项、相关 Renderer 2 文件/16 项通过；typecheck 通过；10 语言/1314 keys 通过。命令和日志映射见证据目录 `parity-results.json`、`reproduce.md`。
- 原生终端脚本在 Windows PowerShell 下受 execution policy 阻止；同脚本在当前 PowerShell host 下执行、probe 通过。qa19 包内 DLL 与验证构建 SHA-256 一致：`506FC589EF72C3DA40406E8F030B0EEE04142A88060EF7775AD01E636E4FA27E`。
- UI 证据来自 qa13/qa14。先前 qa16 隔离进程启动两次被自动审批拒绝，仅返回 `blocked by policy`，未给具体理由；qa19 没有绕过审批启动。新增快捷键、命令另存、保存确认及最终集成 UI 均不能标通过。旧 qa14 测试窗口已正常退出。
- 保留失败复现：`ssh-atomic-before.log`（缺失路径错误）、`ssh-save-safety.log`（权限参数错误）、`ssh-permissions.log`（测试断言未屏蔽 file-type bits，已修正）；最终结果以 `ssh-final-qa19-fixed.log` 为准。

第一批尚未满足完整交付门槛：嵌套迁移后通过 UI 编辑/重启核对、树搜索/拖放/全部菜单目标、代理设置、完整布局及最终构建复验仍未关闭。第二至四批中的打包传输 UI/真实 Linux 复验、快速删除真实 Linux/UI 复验、不发 OSC 7 的 Shell 目录跟随、独立编辑器窗口的实机复验、AI 完整流程及跨端配置迁移、FinalShell 专用导入、LAN Sync 窗口冲突确认/应用/重试流程 UI、全部设置/窗口恢复/引导、RDP runtime 和最终安装包验收继续列为未完成或外部阻塞。LAN Sync 的冲突裁决、事务导入、计数及失败重试已有 Core/协议证据，不再列为代码缺口。

## 2026-11-06 全流程对齐续验：终端搜索与会话生命周期

本批继续按 Electron 用户流程核对 WinUI 入口和 Native Core 行为，补齐一项可在本机闭环的交互差异：Electron 终端搜索支持区分大小写、正则表达式、全部结果计数和当前结果高亮；原生版此前只做不区分大小写的每行首个匹配。`NativeTerminalCanvas.Search` 现支持大小写/正则选项、同一行多结果、正则错误和超时保护，并在搜索对话框显示 `当前/总数`、上一个/下一个和两个选项。会话在活动栏、设置或 AI 覆盖层之间切换时继续保持已选工作区的监控与目录跟随状态，不重建终端；只有切换会话或关闭会话才停用对应工作区。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| Native Core 合同 | PASS | 301 项通过；日志 `build/windows-native-acceptance/full-parity-20261106/revalidation-after-search-20261106-r2/core-contract.log` |
| Native SSH 合同 | PASS | 49 项通过；日志 `build/windows-native-acceptance/full-parity-20261106/revalidation-after-search-20261106-r2/ssh-contract.log` |
| Renderer 测试 | PASS | 1779 项通过、37 项跳过；日志 `build/windows-native-acceptance/full-parity-20261106/revalidation-after-search-20261106-r2/renderer-tests.log` |
| TypeScript / i18n | PASS | `typecheck`、`check:i18n` 通过；i18n 为 10 种语言、1324 个 key |
| x64 原生发布 | PASS | `build/windows-native-acceptance/full-parity-20261106/revalidation-after-search-20261106-r3/app-x64/`；EXE 与 DLL 哈希见同目录 `sha256.txt`、`dll-sha256.txt` |
| 真实窗口 UI | BLOCKED | 当前桌面可绑定窗口只有已安装 Electron；隔离 Native 窗口仍未取得唯一 UIA 句柄，因此搜索选项视觉、键盘操作、覆盖层切换和 DPI 仍不能标为实机通过 |

这项关闭了原生代码层的终端搜索语义差距，但不改变完整对齐状态：拖放、IME、DPI/高对比度、真实 Linux/RDP/AI/Android、最终安装包和其他架构仍需分别验收。

## 2026-11-06 命令库发送流程续补

对照 Electron `SnippetPanel` 和 `CommandEditorModal`，原生命令库此前存在两个用户流程差异：新建快捷命令默认不自动回车；点击命令只改变选择，不直接发送。现在默认 `autoEnter` 与 Electron 一致为开启，点击命令会对当前选中会话展开 `{{host}}`、`{{user}}`、`{{port}}` 后发送；关闭自动回车时仅回填终端，不写入命令历史；自动执行时写入历史并触发 SFTP 目录跟随。原有“发送”按钮仍用于显式选择多个会话和多行确认。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| Native Core 合同 | PASS | 301 项通过，命令库断言覆盖 Electron 默认自动回车、历史会话隔离和占位符展开 |
| WinUI x64 Release | PASS | `build/windows-native-acceptance/full-parity-20261106/revalidation-after-command-flow-20261106/app-x64/` |
| 真实命令库 UI | BLOCKED | 隔离 Native 窗口仍无法取得 UIA 句柄，点击发送、无回车回填和多会话选择尚未取得新的窗口截图证据 |

该项关闭了原生代码/入口层的命令库默认值和单击行为差异，完整 UI 键盘、焦点和多会话实机验收仍待窗口绑定恢复。

qa19 续补：新增 OSC 7 目录通知跟随，设置开关和原生说明已加入 10 语言；仅导航 SFTP，不执行命令。Core 190 项、SSH 49 项通过（含实际 SFTP ViewModel 延迟请求/取消/恢复）。UI timer、隐藏/重连及新设置仍未实机验收，不能标为完整目录跟随等价。

qa19 保存保护续补：临时上传完成后再次核对原文件内容哈希；即使已同意覆盖，上传期间发生的新修改仍返回冲突并清理自己的临时文件。延迟 fixture 的并发写入回归通过；最后核对与替换之间仍不具备远端 CAS 原子保证。

## 2026-11-05 qa20 UI 修复复验

在隔离 qa20 窗口内重新打开 qa19 已保存的两行命令，界面与 UIA 均显示两行正文，`发送后自动回车` 保持关闭。取消编辑后返回命令库；未发送命令。此项已复验通过，完整最终 UI 矩阵仍未完成，原生版仍为预览版。证据：`build/windows-native-acceptance/final-ui-qa19-20261105/21-qa20-multiline-fixed-tree.json`、`21-qa20-multiline-fixed.jpg`；结构化状态见 `build/windows-native-acceptance/parity-batch1-20261104/parity-results.json`。

## 2026-11-06 SFTP 跳过任务队列状态

上传冲突策略选择 `skip` 时，顶层文件和目录内文件现在都会作为独立的 `Skipped` 任务进入传输队列，不增加已传输字节；目录任务汇总跳过数量并在全部子项结束后进入终态，摘要使用当前语言的传输状态文案。跳过任务不接受暂停、恢复、重试或取消，且可由“清理已完成”移除。另已修正下载批量落地语义：与 Electron transfer worker 一致，同名文件直接替换、同名目录合并，并在入队前拒绝本地符号链接和文件/目录类型错配。

隔离 x64 Release 发布成功，版本 0.30.34，launcher SHA-256 `831389D3DF889F26966D10605141C17D77A7C61E1F65BE2507DB6D97D956EE2E`，程序集 SHA-256 `A2A30CCF107E47E531474D09632A45C1F177FB25C2B3587F098A5D3136E02AA1`。Native Core 252 项合同检查通过；本机 SSH/SFTP fixture smoke 24 项通过，覆盖登录、终端往返、SFTP 列表/上传/下载/改名、编辑器编码与保存安全、传输暂停恢复/冲突重试和字节一致性。`npm run check:i18n` 通过（10 种语言、1324 keys）。UI 自动化没有执行，窗口绑定问题仍未解决，因此冲突弹窗和队列的实际视觉呈现仍待复验。日志、结构化结果与复现步骤见 `build/windows-native-acceptance/skipped-transfer-20261106/`。

## 2026-11-06 下载同名目标行为对齐

Electron 的 SFTP 下载 worker 在完整下载并写入临时文件后替换同名本地文件；目录下载递归创建/合并目录。原生入口先前按选择项逐个弹出冲突对话框，并支持与 Electron worker 不同的跳过/改名裁决。现已移除下载入口的逐项裁决，统一走现有队列的验证后替换；仍拒绝本地 reparse/symlink 跟随及文件/目录类型错配。

隔离 x64 Release 发布成功（版本 0.30.34），新程序集 SHA-256 `575D657571389577C0FB20FDE7A49E65615C9196E858192DEC69F43BF9BE4D27`。26 项 SSH/SFTP fixture smoke 全部通过，新增覆盖本地同名文件存在时，下载完成验证后替换并核对最终字节与远端一致。未执行 UI 自动化，故实际入口与文件选择器流程仍需复验；证据见 `build/windows-native-acceptance/download-conflict-20261106/`。

### 2026-11-06 原生启动提示流程

新增 `NativeStartupNotice`，按 Electron 的版本判定语义提供首次运行功能/快捷键引导、升级后的发行说明和同版本静默；当前版本写入原生数据库 `meta` 表，不进入迁移导出。Core 合同达到 271 项，x64 隔离构建和 TypeScript/i18n 检查通过。实际提示 UI 仍受隔离窗口自动化 owner 绑定故障阻断，不能标记为 UI 实机验收通过。

### 2026-11-06 启动提示跨进程回归补充

启动版本标记的合同测试已扩展为跨数据库实例验证：首次打开数据库显示引导，关闭并重新打开同一数据库后同版本保持静默，版本变化显示升级提示。Native Core 合同当前为 271 项通过。




### 2026-11-06 普通 Shell `cd` 跟随续补

原生终端现在复用已回显命令的 `CommandEntered`，对静态可推导的 `cd` 目标进入现有 SFTP 跟随队列；快捷命令带回车也会发出同一事件，未按回车的编辑不会误触发。新增 `NativeShellPathSync` 合同后 Core 达到 273 项，原生 SSH 合同 49 项通过，x64 r3 隔离构建通过。变量、`cd -`、命令替换保持不跟随；实际窗口 UI、失败提示和重连矩阵仍待自动化绑定恢复后验收。



## 2026-11-06 独立编辑器窗口实现

WinUI 现通过 NativeEditorWindowHost 提供与 Electron 相同层级的跨会话独立编辑器窗口。文档按 sessionId 与远端路径区分，单窗口最多 10 个；关闭标签、关闭编辑器窗口或退出主窗口时执行保存/放弃/取消裁决。SSH 会话断开后保留编辑草稿并禁用远端保存与重读，重连后恢复。NativeRemoteEditor 使用主编辑窗口 XamlRoot 作为非活动标签弹窗回退根，确保未选中标签仍可安全完成保存冲突裁决。

验证：x64 Release build/publish、Core 273 项、SSH 49 项、TypeScript typecheck、i18n 均通过。隔离包启动尝试被本机策略拒绝（blocked by policy），因此尚无独立窗口、切换、关闭确认或截图实机证据。


## 2026-11-06 LAN Sync 回执与导入结果对齐

原生 LAN Sync 导入现在按实际写入结果反馈连接、分组、代理、私钥、AI Provider、快捷命令、转发、known hosts、凭据和跳过数量；`applied` 回执扩展了这些计数字段，并对旧对端保持可选字段兼容。原生设置导入沿用 Electron 的局部合并语义，实体冲突策略不再阻止显式选中的 settings；known-host 信任决策始终保留本机值，失效转发引用会被跳过并计入结果。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core 合同 | PASS，280 项 | `build/windows-native-acceptance/full-parity-20261106/core-lansync-result.log` |
| Native SSH 合同 | PASS，49 项 | 本轮回归构建输出；既有 fixture 契约保持通过 |
| TypeScript / 本地化 | PASS | `npm run typecheck`、`npm run check:i18n` |
| x64 Release self-contained 发布 | PASS | `build/windows-native-acceptance/full-parity-20261106/lan-sync-results-x64-r3/`；EXE SHA-256 `A230E1D0E70B1CF4785180472403B1C4DD1A47F489F378FBD1859FE928F15129` |
| 原生 LAN Sync 窗口实测 | NOT RUN | 需手动启动 r3 隔离构建并由桌面自动化绑定后复验；本批未执行导入或修改用户数据 |

结构化结果：`build/windows-native-acceptance/full-parity-20261106/lan-sync-results.json`。

## 2026-11-06 全流程回归复跑

在不启动安装版 Native Preview、不读取生产数据的前提下，复跑了当前工作区的共享契约与迁移回归：Native Core 280 项、Native SSH 49 项、Electron 迁移/LAN Sync 相关测试 3 个文件共 45 项、TypeScript 和 10 种语言本地化检查均通过。结构化结果见 `build/windows-native-acceptance/full-parity-20261106/revalidation-20261106/revalidation-results.json`。

本轮另修复导入后的 Native UI 刷新：文件、LAN Sync 与 FinalShell 导入统一刷新设置、连接/分组、密钥、代理、known hosts、转发、命令库和 AI Provider，并显示实际写入/跳过计数。修复版 x64 隔离程序为 `build/windows-native-acceptance/full-parity-20261106/revalidation-20261106/app-x64-r3/OpenFinalShell.App.exe`，SHA-256 `EFE912E8003B85BCB953B27C0DB9A7666AB1E7DAC42159B756CF91751189F87E`。桌面清单复核时仅发现 Electron 安装版窗口，未发现 Native Preview 进程；因此工作台、迁移、LAN Sync、启动提示、编辑器窗口和响应式布局仍没有本次新增的 UI Automation/截图证据。复验结果见同目录 `revalidation-results.json`。

原生迁移默认类别也已调整为与 Electron 一致：连接及依赖、AI Provider、快捷命令、转发和 known hosts 默认选中，settings 默认不选，避免导入时静默覆盖本机外观和偏好；用户可以在确认对话框中显式勾选 settings。该修复的 Core 合同为 281 项，类别修复版位于 `build/windows-native-acceptance/full-parity-20261106/category-defaults-20261106/app-x64-r1/`。窗口复选框实际呈现仍待隔离 UI 验收。

## 2026-11-07 SFTP 导航与拖放入口续补

为缩小 Electron `SftpPane` 与 WinUI 原生浏览器的交互差异，原生 SFTP 现在提供：

- 面包屑路径栏：根目录及每一级目录均可直接点击，导航复用现有 REALPATH、取消、刷新和终端目录跟随流程；当前目录按钮保持禁用，避免重复请求。
- 返回/前进历史：返回、前进、上级目录、面包屑和终端目录跟随共用一个规范化目录历史；新导航会截断前进项，失败导航不会移动历史游标。
- 拖放覆盖提示：仅在拖入 Windows StorageItems、会话就绪且目录请求未进行时接受拖放；悬停单个目录行时显示该目录，空白处或文件行回退到当前目录；导航期间不接受落点。
- 文件双击下载：当设置的双击动作不是“打开编辑器”时，直接以当前文件作为单项下载目标，不再依赖可能变化的 ListView 选区。
- 文件列表表头：增加名称、类型、大小、修改时间和权限列，与 Electron 表格的主要可见信息保持一致；表头和内容支持横向滚动，窄窗口不裁切主操作。

新增 `NativeSftpDropTarget` 与 `NativeSftpNavigationHistory` Core 合同，覆盖目录行/文件行/空白处落点、断线、导航中、不安全路径、返回/前进及新导航截断。当前 Core 合同为 309 项通过；x64 隔离发布见 `build/windows-native-acceptance/full-parity-20261107/app-x64/`。本批未启动隔离 Native 窗口，因此拖放视觉、面包屑点击、返回/前进按钮和文件列表列宽仍需 UI Automation 实机证据；Explorer 管理员拖放限制也要单独记录。


### 2026-11-07 连接树键盘上下文菜单

`NativeConnectionTree` 的鼠标右键、Windows 菜单键和 Shift+F10 现在共用目标捕获和菜单动作分发，菜单项提供 AutomationName。代码与编译验证已完成；由于隔离窗口尚未运行，本项状态为“代码/构建通过，UI 待验收”。

### 2026-11-07 SFTP 右键上传入口

WinUI `NativeSftpBrowser` 右键菜单补齐 Electron 的文件/目录上传入口：空白处落当前目录，目录行落该目录，文件行回退当前目录；操作复用现有冲突规划和传输队列。代码与 x64 构建通过，UI 仍待隔离窗口验证。

### 2026-11-07 SFTP 键盘上下文菜单

`NativeSftpBrowser` 右键菜单补齐菜单键/Shift+F10 入口，并在打开时保存选择集，避免异步动作受列表重渲染影响。代码与隔离发布通过，实际 UI 仍待验收。

### 2026-11-07 原生传输队列显示续补

WinUI 传输列表已从单行摘要扩展为摘要、源/目标路径、进度条和字节计数，复用已有 `NativeTransferTask` 字段，不改变队列控制或持久化语义。代码与隔离构建通过，UIA 仍待验收。

### 2026-11-07 AI 响应模式对齐

Electron AI 助手允许在流式和非流式响应之间切换。原生版此前固定调用 SSE 流式接口，导致同一 Provider 的非流式契约无法从 WinUI 使用。现已补齐：原生 AI 面板增加响应模式选择；流式模式继续逐增量更新，非流式模式发送 `stream:false` 并解析 OpenAI-compatible JSON 响应，同时支持字符串和文本内容数组。取消、输入大小、图片校验、Token 引用和 `aiAssistantEnabled` 门控保持不变。

验证：Native Core 合同 319 项通过，新增非流式完整响应、内容数组拼接、Electron 请求参数、消息/内容部分上限、真实聊天连接探测、图片能力 JSON 响应、错误分类、Accept 协商、模型列表 4 MiB 上限、空模型列表错误及各操作超时设置；TypeScript、10 种语言本地化、应用 Release 编译和 x64 self-contained 发布通过。原生 AI 面板另已接入发送/选图/取消状态门控，防止运行中重复请求。新隔离包位于 `build/windows-native-acceptance/full-flow-20261107/app-x64-r10/`，结构化结果为 `build/windows-native-acceptance/full-flow-20261107/results-r10.json`。窗口 UIA 仍未执行，必须在隔离窗口中复验响应模式控件、发送/取消和真实 Provider 返回。

### 2026-11-07 全局传输暂停/取消

WinUI 传输侧栏新增全部暂停和全部取消，取消操作按当前可取消叶子任务计数并要求确认；Core 从顶层任务发起级联，避免父子任务重复执行。另为选中任务加入状态门控、已完成下载资源管理器定位和 Electron 对齐的叶子任务总览（完成/失败、已传/总字节、未知任务、上下行速度、ETA），总览每秒刷新并对累计值溢出作饱和处理。复用 Electron 现有本地化键，不新增 IPC、持久化字段或导出格式。Native Core 323 项、Native SSH 49 项、TypeScript、i18n 与 x64 self-contained 发布通过；最新包 `build/windows-native-acceptance/full-flow-20261107/app-x64-r15/`。窗口按钮、确认交互、总览和资源管理器定位仍为 UI 待测，结果记录在 `results-r15.json`。

## 2026-11-07 SFTP 表头排序与属主列续补

对照 Electron `SftpPane` 的可见列与排序行为，原生 SFTP 表格补齐名称、大小和修改时间表头点击排序，活动列显示升/降序指示，目录仍恒排在文件前；表格显示类型、权限、属主 UID、用户组 GID 和修改时间，表头与行共享横向滚动位置。排序逻辑抽到 `NativeSftpSort`，界面与合同测试共用同一实现。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native Core 合同 | PASS，326 项 | `build/windows-native-acceptance/full-flow-20261107/core-contract-r17.log`；覆盖目录优先、名称升序、大小降序和修改时间升序 |
| Native SSH 合同 | PASS，49 项 | `build/windows-native-acceptance/full-flow-20261107/ssh-contract-r17.log` |
| TypeScript / 本地化 | PASS | `typecheck-r17.log`、`i18n-r17.log`；10 种语言新增 `sftp.colGroup` |
| x64 self-contained 发布 | PASS | `build/windows-native-acceptance/full-flow-20261107/app-x64-r18/`；结构化结果 `results-r18.json` |
| Native UI Automation | BLOCKED | 隔离窗口由用户启动并出现在窗口清单中，但 Computer Use 状态读取报 HWND 与 owner 不匹配；没有截图、排序点击或横向滚动实测 |

Electron 从 SFTP 长名称展示用户名/组名，原生 SSH.NET 目前只显示数字 UID/GID；本批补齐信息可见性和排序入口，属主名称仍是兼容差异。
