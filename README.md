# OpenFinalShell

OpenFinalShell 是一个开源、跨平台的远程运维工作台，集成 SSH 终端、SFTP 文件管理、嵌入式 RDP 远程桌面、AI 助手、在线编辑、服务器监控和端口转发。你可以在同一应用中管理 Linux 服务器和 Windows 远程桌面，传输文件、修改配置、查看运行状态，并按需调用自己的 AI API 辅助排障。

项目由两部分组成：

- **桌面端**：基于 Electron、React 和 TypeScript，提供 Windows x86/x64/ARM64、macOS Intel x64 / Apple Silicon ARM64、Linux x64/ARM64 安装包；Flatpak 目前仅提供 x64。
- **Android 端**：独立的 Kotlin 原生客户端，使用 Jetpack Compose、Apache MINA SSHD、Room 和 Android Keystore，支持 API 26 及以上的常见 CPU 架构。

核心能力：

- **SSH / SFTP**：多标签终端、搜索与命令历史、拖拽上传、文件冲突处理、传输队列和断点续传，支持独立窗口编辑远程文件。
- **RDP 远程桌面**：在标签页内连接远程桌面，支持键鼠操作和窗口自适应；Windows x64 支持原生文件双向复制粘贴、本地文件拖入远程桌面和远程音频播放。
- **AI 助手**：接入 OpenAI、DeepSeek 或第三方兼容 API，获取模型列表、检测图片输入、选择流式或非流式回答，将回答中的命令复制或手动填入 SSH。
- **服务器监控与转发**：CPU、内存、磁盘、网络、进程、连接数、双延迟和端口流量视图；支持本地、远程及动态 SOCKS5 转发。
- **Windows 多实例**：在设置中开启多个独立窗口，连接配置和凭据共享，会话、传输和窗口退出互相隔离。
- **数据与界面**：系统安全存储、加密导入导出、局域网配对传送、10 种界面语言、主题和缩放设置。

桌面端与 Android 的功能范围不同。下表按当前代码和发布配置列出支持情况；构建通过不等于已完成所有远程服务器、文件管理器和显示环境的实机验收。

| 平台 | SSH / SFTP | 嵌入式 RDP | RDP 原生双向文件粘贴 | AI 助手 | 独立多实例窗口 |
| --- | --- | --- | --- | --- | --- |
| Windows x64 | 支持 | 支持 | Windows Explorer | 支持 | 支持，设置中开启 |
| Windows x86 / ARM64 | 支持 | 未打包 Worker，可使用系统 RDP | 由系统 RDP 客户端提供 | 支持 | 支持，设置中开启 |
| macOS x64 / ARM64 | 支持 | 真实 FreeRDP Worker | 缓存后原生粘贴已接入，待实机验收、默认关闭 | 支持 | 已适配，待验收 |
| Linux x64 / ARM64 | 支持 | 真实 FreeRDP Worker | 缓存后原生粘贴已接入，待实机验收、默认关闭 | 支持 | 已适配，待验收 |
| Android 8.0+ | 原生客户端，本轮补齐代理、SAF、编辑和本地终端 | 暂不支持 | 暂不支持 | 已接入，APK 与模拟器测试通过，待实机验收 | 不适用 |

Android 的**本地终端**在本机上直接运行 shell，分三档权限：应用自身、ADB shell（uid 2000，经 Shizuku）、root（uid 0，经 Shizuku-as-root 或 `su`）。档位每次连接时重新探测而非缓存。终端、文件、监控与 AI 助手都接入了本地会话 —— 它实现的是同一个 `SshTransport` 契约。root 档在构建开关之外还需在设置中显式开启，每次连接前弹确认说明 uid 0 能读到本应用保存的凭据，且确认不落盘。应用档在未授予「所有文件访问权限」时看不到 `/sdcard`；ADB 与 root 档的 PTY 由随包的可执行 `libofspty.so` 在特权进程中分配。特权档与 root 档尚待实机验收。

macOS/Linux 的 RDP 基础连接、画面、键鼠和缩放已有实现。本轮将文本剪贴板替换为 macOS NSPasteboard 与 Linux GTK3 原生接口，不再依赖 `pbcopy`、`xclip` 或 `wl-clipboard`。文件粘贴采用完整下载到私有缓存后再发布文件 URL 的方式；新增音频后端和多实例适配仍受实机验收门槛控制。当前仅有 Windows 验证环境，不能将这些代码接入视为 macOS/Linux 正式验收通过。系统 RDP 入口仍通过 `.rdp` 文件调用已安装的默认处理程序。

本轮逐项实现和验证状态见 [多端增量移植记录](docs/platform-port-status.md)。

[下载最新版本](https://github.com/kexue-aihao/openfinalshell/releases/latest) · [多实例说明](docs/multi-instance.md) · [AI 模型与图片检测](docs/ai-model-capabilities.md) · [RDP 文件传输诊断](docs/rdp-clipboard-debugging.md)

---

## 功能

### 连接管理

- 分组树（可嵌套）、按名称/主机/用户名搜索、右键菜单（连接 / 编辑 / 复制连接 / 复制 `ssh` 命令 / 删除）
- 每条连接可挂一个**标签颜色**（8 色预置），在树与标签页上都看得见
- 欢迎页有**快速连接**：直接敲 `ssh root@10.0.0.5:22`（也认 `user@host` 与裸 `host`）就连，同时落成一条正式配置便于复用；旁边是最近使用的 8 条
- 认证方式三种：**密码**、**私钥**（口令可存）、**SSH Agent**；服务器要求 keyboard-interactive 时弹框补答，只有一个 password 提示且已存密码时自动应答
- 主机指纹 **TOFU**：首次连接显示 SHA256 指纹让你确认（可选"仅本次"或"信任并保存"）；指纹变更时是一个醒目的告警框，且**同主机不同算法各记一条**，不会误报
- 高级项按连接配置：字符编码（UTF-8 / GBK 等，经 iconv-lite 双向转码）、终端类型、登录后自动执行的命令、心跳间隔、连接超时、启用压缩、**兼容老算法**（给老交换机/堡垒机追加 `ssh-rsa`、`dh-group14-sha1`、`aes128-cbc`）、是否自动开监控
- **经代理拨号**：HTTP CONNECT 或 SOCKS5（支持认证），域名交给代理解析 —— 本机解析不了的内网域名也能连。代理阶段的报错独立成一类，不会被翻译成"目标主机端口未开放"之类的误导文案
- **代理与私钥配一次、到处引用**（设置 → 代理与私钥）：一个 Clash 混合端口、一把 ed25519，
  存成一条记录，新增机器时在连接编辑里从下拉框选它即可，改端口/换路径只改一处。
  每条记录显示"有几台机器在用"，**被引用时删不掉** —— 弹框列出正在用它的连接名，
  让你先去改那几条，而不是等某天连不上了才发现。密码与口令仍走系统密钥库，界面层拿不到明文。
  升级到本版时，原来内联在每条连接上的代理与私钥路径会**自动抽成可复用记录并去重**（口令原样保留）
- **断线自动重连**：指数退避 1→2→4→8→15→30 秒、最多 10 次，也可以随时"立即重连"。重连后终端缓冲不丢（会打一行"—— 连接已恢复 ——"），监控与端口转发自动接回

### 终端

- 多标签会话，同一条配置可以开多个；标签右键：重命名 / 复制会话 / 重新连接 / 关闭 / 关闭其他 / 关闭右侧 / 全部关闭
- xterm.js + **WebGL 渲染**（可关，回退 DOM）、真彩色、Unicode 11 宽字符（中文与 emoji 对齐）、链接可点
- `Ctrl+F` 查找条：上一个/下一个、区分大小写、正则
- **命令历史**（`Ctrl+Shift+H`，或悬浮工具条上的钟表图标）：记下你在终端里**真正执行过**的命令，
  贴着终端底部浮出一份列表，可输入关键词过滤、`↑↓` 选择。点一条**只回填到命令行、不会自动执行** ——
  要跑再自己按一下回车。同一条命令执行多次只占一行（右边显示次数），落在本机数据库里、跨重启还在，
  上限 1000 条。浮层里有「清空列表」，设置 → 终端里可以整个关掉记录
- 选中即复制、右键粘贴（也可改成弹菜单）、**多行粘贴前确认**（避免一贴就执行）
- 输入法友好：组词期间不会误触快捷键
- 悬浮工具条：开关文件管理、开关监控、查找、清屏、断开
- 可调字体、字号、行高、光标样式与闪烁、回滚行数（1000–100000）
- 6 套终端配色（One Dark / Dracula / Nord / Solarized Dark / GitHub Light / Solarized Light），也可跟随界面主题；设置页里有实时预览
- 主进程侧对下行数据做批处理（8ms / 256KB 双阈值）并按水位背压：`cat` 一个大文件不会撑爆内存，`Ctrl+C` 立即生效

### 嵌入式 RDP 远程桌面

新建连接时选择 RDP，配置主机、端口、用户名、域、凭据及证书策略，即可在应用标签页内连接远程桌面。

- 使用独立 FreeRDP Worker，支持画面渲染、键盘、鼠标、滚轮及远程分辨率调整；窗口或面板尺寸变化时自动适配显示。
- 可配置剪贴板同步和音频播放。Windows x64 音频使用本机默认播放设备；没有设备时不影响桌面连接。
- **Windows x64 文件上传**：在本地 Explorer 复制文件或目录，到远程 Explorer 的目标目录粘贴；也可把本地文件拖入 RDP 画面，由远程桌面处理粘贴。
- **Windows x64 文件下载**：在远程 Explorer 复制文件或目录，到本地 Explorer 粘贴；界面另提供“下载到目录”入口。
- 文件传输使用 RDP `cliprdr`，按需分块读取并显示传输状态；断线或关闭会话时使挂起读取失效。拖放的目标需要能够接收文件，例如远程桌面或 Explorer 文件夹窗口。
- 关闭标签只结束当前会话，RDP 重连由用户显式触发。旧 Worker 的认证、画面和剪贴板回调不会接管新会话。
- Worker 不可用时可显式选择系统远程桌面；生成的 `.rdp` 文件不包含密码。

原生文件粘贴依赖服务端允许剪贴板重定向。当前限制为最多 64 个文件/目录条目、单文件 8 GiB、合计 32 GiB；拒绝符号链接及不安全的相对路径。macOS/Linux 不作为原生双向文件粘贴已完成的平台，详见上方支持表。

### AI 助手

在 **设置 → AI 助手** 开启功能，添加服务名称、API Base URL、Token 和模型；随后可从侧栏 AI 图标或 SSH 终端工具条打开独立的助手面板，无需先选中文字。

- 支持 OpenAI 官方、DeepSeek 官方及 OpenAI Chat Completions 兼容服务，可保存并切换多个服务配置。
- 填写 API 地址和 Token 后点击“获取模型”，通过 `/models` 获取列表并在可搜索下拉框中选择，也支持手动填写模型名称。
- “测试连接”显示请求耗时，包含网络传输和模型处理；“测试图片输入”单独检查当前接口是否接受图片请求。
- 支持文字和 PNG / JPEG / WebP / GIF 图片输入，当前面板每次可附加一张不超过 8 MiB 的图片；实际图片理解能力取决于模型与网关。
- 可选择流式或非流式响应，支持停止生成、清空当前回答和错误提示。
- 选中终端文本后可显式发送给 AI，用于解释错误、解释命令、生成修复方案或自定义提问；不会自动读取整段终端历史、服务器文件或登录凭据。
- 回答中的 shell 命令提供“复制”和“填入 SSH”，可以选择目标 SSH 终端。填入不发送回车；多行命令需要终端启用 bracketed paste。
- Token 由主进程保存到系统安全存储，查询配置只返回是否已设置。AI 配置和 Token 不进入普通数据导出或局域网同步。

功能默认关闭，API 费用由所选服务商收取。Base URL 通常填写到 `/v1`，程序追加 `/chat/completions`；第三方接口可保留自己的路径前缀。仅允许 HTTPS，本机 `localhost`、`127.0.0.1`、`::1` 可使用 HTTP。当前每次发送仅提交本次填写/选中的文本与图片，不自动携带之前问答，也不持久化聊天记录。单条文本上限为 32,768 个字符。

模型列表中的“图片未声明”不表示模型不可用；可用“测试图片输入”进一步检查。接口接受测试图片也不能证明它实际理解了图片，详细判定规则见 [AI 模型与图片检测](docs/ai-model-capabilities.md)。

### Windows 多实例窗口

在 **设置 → 常规 → 允许多实例窗口** 开启或关闭，无需重启。默认关闭；普通双击始终优先聚焦已有默认窗口。

- 开启后可通过左上角应用名称菜单、`Ctrl+Shift+N`、任务栏“打开新窗口”或 `OpenFinalShell.exe --new-instance` 创建独立进程和窗口。
- 各窗口的 SSH/RDP 会话、终端、传输、监控、端口转发和 AI 请求互相隔离；关闭一个窗口只清理自己的资源。
- 连接、AI 服务配置和凭据共享。配置变更自动刷新，编辑过期版本会提示冲突；已连接会话不被配置刷新替换。
- 关闭开关只禁止新建实例，已有窗口、会话和传输继续运行；偏好跨重启保留。
- 安装更新由协调实例统一处理，等待其他实例清理并退出；超时显示仍在运行的实例，不强制结束进程。

当前仅 Windows 开放多实例；不支持跨实例接管运行中的会话。架构和测试记录见 [多实例说明](docs/multi-instance.md)。

### SFTP 文件管理

- 会话连上后**自动展开**下方分屏（可关），起始目录是远端 home
- 虚拟表格减少大目录的渲染开销；名称 / 大小 / 权限 / 所有者 / 修改时间可排序；目录恒排最前
- 默认**显示隐藏文件**（工具栏眼睛按钮随时切换）
- 导航：后退 / 前进 / 上级 / 刷新、面包屑逐段跳转、点一下变成可编辑的路径输入框
- 可开启跟随终端 `cd`，将文件列表切换到终端进入的目录。
- 新建文件 / 文件夹（重名或无权限会明确报错，不静默失败）、`F2` 重命名、复制路径
- 权限编辑：八进制输入框 + 读/写/执行九宫格
- **上传**：工具栏选文件，或直接把文件拖进来 —— **拖到某个目录行上就传进那个目录**（那一行会高亮）
- **下载**：可设默认下载目录（留空则每次询问）；落地文件名会做 Windows 非法名归一
- 同名冲突支持询问、覆盖、跳过或重命名；上传前可逐项裁决，也可批量应用策略。
- 传输队列：单会话并发数与全局并发数可配，支持暂停 / 继续 / 取消 / 重试 / 清除已完成，显示速度与剩余时间；暂停后按 `.part` 偏移**断点续传**
- 目录传输**渐进式展开**，边遍历边入队，无需等整棵目录树扫描完成。
- 传输走**第二条 SSH 连接**（懒创建、空闲 60 秒自动关），所以传大文件不会给击键加延迟
- 文件名不是合法 UTF-8 的条目标黄并禁止操作（见"已知限制"）
- **快速删除（`rm -rf`）**：在服务器上跑一条命令删整棵目录树，比逐个 unlink 快几个数量级。只对目录提供、独立的二次确认框、**把将要执行的那条命令原样列出来**给你过目；层级少于两级的路径（`/`、`/etc`、`/root`…）一律拒绝
- **打包传输**（默认关，右键菜单里勾选）：下载整个目录时先在远端打成一个 tar、传一个文件、再本机解包，上千个小文件能快几个数量级。它是**建议性**的 —— 文件数太少、远端没有 tar/mktemp、空间不够、与冲突策略不相容时自动改回逐文件，并在那条任务上写明原因。目前只对下载生效

### 内置编辑器（改远端文件）

右键一个文件 →「内置编辑器查看」，或按设置双击文件，在独立编辑器窗口中以多标签查看和编辑。打开文件只读取内容；保存前内容保留在内存，不生成本地明文编辑副本。

- CodeMirror 6：行号、结构折叠、括号匹配、撤销历史、`Ctrl+F` 查找、`Tab` 插缩进
- 语法高亮 16 种：json / yaml 用真解析器（有语法树），shell、nginx、properties、toml、dockerfile、diff、lua、perl、python、javascript、xml、html、sql、css 走 legacy 模式
- 状态条上直接切**编码**（UTF-8 / GB18030 / GBK / Big5 / Latin-1），换编码只是重读、不会写远端；同时显示行尾类型、BOM、远端权限位
- `Ctrl+S` 存回远端（只在编辑器有焦点时生效 —— 终端里的 `Ctrl+S` 是流控，不抢）
- 写回走 `posix-rename` **原子替换**并保留原权限位；软链会解析成真身再编辑
- 保存前有**三道闸门**，每道各要一次单独确认：远端在你编辑期间被改过 / 这台服务器不支持原子替换 / 内容比远端短了一大截
- 另有几种情况**一律拒绝保存**（没有任何确认能让它变安全）：打的字在目标编码里存不下去（会点名那个字符）、打开时那份字节本来就解不干净、编码后超过 8MB、这条路径此刻已经指向另一个文件
- 每个文件各自暂存编辑状态：改了 A → 切到 B → 切回 A，改动与撤销历史都还在
- 单文件上限 8MB、同时最多开 10 个

### 实时服务器监控

连上即自动展开（可按连接关掉），默认 2 秒刷新（1–10 秒可调）。采集在服务器侧只占**一个常驻 exec 通道**。

- 系统信息：主机名、发行版、内核与架构、IP 列表、运行时间
- **CPU**：总占用 + 折线，展开看每个核心；1/5/15 分钟负载
- **内存**：已用/总量 + 折线，有 Swap 时单独一条
- **网络**：上行/下行速率双线图
- **双延迟**：并列显示本机直连 ICMP 延迟与当前 SSH 数据通道延迟，便于区分直接网络和代理/隧道链路。
- **端口流量**：从监控面板打开独立工具标签，查看各端口连接数和收发速率；远端缺少可用计数器时显示不可用，不把缺失值当作零流量。
- **磁盘**：各挂载点容量条（>75% 变黄、>90% 变红）+ 每设备读写速率
- **连接数**：TCP 总数、TIME_WAIT、ESTABLISHED / LISTEN / CLOSE_WAIT 明细、孤儿连接、已打开的 UDP 套接字
- **进程 Top**：按 CPU 排序的前 8 个（可折叠）
- 采集失败可一键重试；非 Linux 系统显示"暂不支持监控"，终端与文件管理不受影响

### 端口转发

- 三型：**本地 (-L)**、**远程 (-R)**、**动态 (SOCKS5)**（自实现的 SOCKS5 服务端，可直接配到浏览器）
- 每条规则可"连接时自动启动"，断线后随重连自动恢复
- 面板上实时显示状态、当前连接数与累计流量（双向都计）
- 报错说人话：端口被占用、1024 以下需要管理员、远端拒绝监听（非 127.0.0.1 需服务器开 `GatewayPorts`）

### 快捷命令与命令编辑器

- **命令编辑器**（快捷命令面板工具条上的铅笔按钮）：一块多行文本框，用来**临时拼一段**命令
  （多行脚本、一次性的 for 循环、从别处贴进来改两个字段），`Ctrl+Enter` 或「发送」发到
  **当前会话**或**所有会话**。两个开关：「自动回车」决定是真的执行还是把内容停在命令行上等你按回车，
  「展开占位符」决定发送前要不要按目标会话替换 `{{host}}` 之类。写完觉得值得留就点「保存为快捷命令」。
  行尾一律归一成 LF（`\r\n` 发给行编辑器等于一行按两次回车，会让 here-doc 错位）、末尾多敲的空行丢掉。
  真的执行了的那些会进命令历史。⚠️ 正文**不跨「打开」保留**：每次打开都是空白、发送成功后自动清空并关窗（回终端看效果），真值得留的点「保存为快捷命令」
- 快捷命令：分组管理，一键发送到**当前终端**或**所有终端**
- 支持 `{{host}}` / `{{user}}` / `{{port}}` 占位符，发送时按目标会话替换
- 可设"自动回车"；真的执行了的那些会进命令历史（面板底部也有一份最近 20 条，点一条回填到命令行）

### 界面与设置

设置页提供十个区段：常规 / 外观 / AI 助手 / 终端 / 传输与监控 / 代理与私钥 / 安全与数据 / 局域网同步 / 快捷键 / 关于。

- 深色 / 浅色 / 跟随系统，8 种强调色，界面缩放 90%–150%
- 10 种界面语言：简体中文、繁体中文、英语、日语、韩语、俄语、西班牙语、法语、德语和巴西葡萄牙语；部分新增文案及机器翻译仍需母语校对。
- 关闭标签前确认（仅在会话仍连接时问）、禁用硬件加速（老显卡黑屏时用）
- 侧栏四个视图：连接 / 快捷命令 / 端口转发 / 传输队列；启用 AI 后增加助手入口。面板尺寸与折叠状态会保留，标题栏使用统一软件 Logo。

| 快捷键 | 作用 |
|---|---|
| `Ctrl + Shift + T` | 复制当前会话 |
| `Ctrl + Shift + N` | 打开新实例窗口（Windows，需开启多实例） |
| `Ctrl + W` | 关闭当前标签 |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | 下一个 / 上一个标签 |
| `Alt + 1…9` | 切换到第 N 个标签 |
| `Ctrl + F` | 在终端中查找 |
| `Ctrl + Shift + H` | 打开命令历史 |
| `Ctrl + Shift + C` / `Ctrl + Shift + V` | 复制 / 粘贴 |
| `Ctrl + C` | 发送中断信号（不会被拦截） |
| `Ctrl + S` | 保存远端文件（编辑器有焦点时） |
| `Ctrl + Enter` | 命令编辑器：发送 |
| `F2` | 重命名文件（文件管理器内） |
| `Esc` | 关闭查找条 / 取消重命名 |

macOS 常用快捷键采用 Cmd / Option 语义，以“设置 → 快捷键”的平台说明为准。

### 数据安全与迁移

- 密码与私钥口令经系统密钥库加密（Windows 走 DPAPI，Debian 桌面走 Secret Service）后存进本机数据库，**已保存的密码永不回传界面层**，日志里的敏感字段自动脱敏
- 私钥默认只保存外部文件路径；在「代理与私钥」里勾选**在本软件中保存加密副本**后，私钥内容会由主进程读取并用系统密钥库保护，原文件不可用时自动使用副本。Windows 可移动磁盘换盘符时，会按原相对路径搜索其它盘符，并用 SHA-256 指纹确认后自动更新路径；副本与私钥内容不会进入配置导出或局域网同步，换机需重新添加私钥文件
- **配置也在库里加密（at-rest）**：除密码外，主机 / 端口 / 用户名 / 备注 / 分组名 / 代理 / 转发 / 已信任主机 / 命令历史也用一把受 `safeStorage`（Windows DPAPI / Linux Secret Service）保护的主密钥加密落盘（AES-256-GCM，等值查找列用 HMAC token）——直接用 SQLite 工具打开 `.db` 看不到明文；`safeStorage` 不可用的环境自动降级为明文、不影响使用（界面设置本身不含机密，仍明文存）
- 数据落**单文件 SQLite**（Windows 为 `%APPDATA%\OpenFinalShell\config\openfinalshell.db`，Debian 为 `~/.config/OpenFinalShell/config/openfinalshell.db`，WAL）：改一条连接不重写整个文件，多实例同时运行也不会互相覆盖
- **导出 / 导入**（设置 → 安全与数据）：连接、分组、快捷命令、转发规则、已信任主机、界面设置导出为一个 JSON。勾选"含已保存的密码"时用你给的导出口令重新加密（scrypt + AES-256-GCM），不勾则文件里没有任何密码；再勾**"整文件加密"**则连主机 / 用户名等配置也一起加密（formatVersion 2），文件里没有任何明文
- 导入可逐项勾选，同名数据可选跳过 / 覆盖 / 另存为副本；**已信任的主机指纹不会被文件覆盖**（覆盖等于替你吞掉中间人告警）
- **从 FinalShell 导入**（设置 → 安全与数据）：选它的数据目录（含 `conn` 子目录），把连接与分组搬过来 ——
  名称、主机、端口、用户名、终端编码、备注、分组层级。**密码不会跟过来**，理由见「已知限制」；
  首次连接时输入一次并勾"记住密码"，那一下就由本机密钥库加密保存
- **命令历史刻意不进导出文件**：导出文件是拿来换机、发给同事的，而命令行上偶尔真的带口令（`mysql -pxxx`、`curl -u a:b`）
- **局域网同步**（设置 → 局域网同步）：把连接等数据直接发到同一局域网内的另一台设备，免去"导出文件再传过去"。一台点「接收」亮出 6 位配对码，另一台扫描或手输地址、输码即发；对方确认后按跳过 / 覆盖 / 另存为副本合并。传输全程加密（配对码经 X25519+scrypt 派生会话密钥，线上是与导出同构的整文件加密信封，除设备名等元数据外无明文），**发一份副本、不是双向同步**（删除不会传播）。组播搜不到设备时手输 `IP:端口` 即可
- ⚠️ Windows NSIS **卸载会清空本机数据**（`deleteAppDataOnUninstall`），卸载前请先导出；Debian 的覆盖升级和卸载保留 `~/.config/OpenFinalShell`。换机仍应走导出/导入或局域网同步 —— 主密钥（连同它保护的全部配置与密码）绑定当前系统用户，换机 / 换账户后直接拷数据库整份都解不开，必须用"导出 → 新机导入"或"局域网同步"

---

## 安装

到 [最新正式版](https://github.com/kexue-aihao/openfinalshell/releases/latest) 下载安装包。当前发布矩阵为 Windows x86/x64/ARM64、Linux x64/ARM64、macOS Intel x64 / Apple Silicon ARM64，以及 Android 各 ABI APK 和 AAB：

当前不提供 Linux i386 / ARMv7 或 macOS Universal 包；Flatpak 仅提供 x64。Linux i386 缺少 Electron 43 官方运行时。

| 文件 | 说明 |
|---|---|
| `OpenFinalShell-<版本>-setup-x64.exe` | 64 位安装版（NSIS，免管理员，装到 `%LOCALAPPDATA%`） |
| `OpenFinalShell-<版本>-setup-ia32.exe` | 32 位安装版 |
| `OpenFinalShell-<版本>-setup-arm64.exe` | ARM64 安装版 |
| `OpenFinalShell-<版本>-portable-x64.exe` | 64 位免安装版 |
| `OpenFinalShell-<版本>-portable-ia32.exe` | 32 位免安装版 |
| `OpenFinalShell-<版本>-portable-arm64.exe` | ARM64 免安装版 |
| `OpenFinalShell-<版本>-debian13-{amd64,arm64}.deb` | Debian 13 安装包 |
| `OpenFinalShell-<版本>-linux-{x86_64,aarch64}.rpm` | RPM 格式安装包 |
| `OpenFinalShell-<版本>-linux-{x86_64,arm64}.AppImage` | Linux 免安装包 |
| `OpenFinalShell-<版本>-linux-x86_64.flatpak` | x86_64 Flatpak 包 |
| `OpenFinalShell-<版本>.dmg` / `OpenFinalShell-<版本>-arm64.dmg` | macOS Intel / Apple Silicon 安装镜像 |
| `OpenFinalShell-<版本>-mac.zip` / `OpenFinalShell-<版本>-arm64-mac.zip` | macOS Intel / Apple Silicon 压缩包 |
| `OpenFinalShell-<版本>-android-{arm64-v8a,armeabi-v7a,x86_64,x86,universal}.apk` | Android APK |
| `OpenFinalShell-<版本>-android.aab` | Android App Bundle |

同目录的 `SHA256SUMS.txt` 和 `SHA256SUMS-android.txt` 可校验（另有 `latest-*.yml` 与 `*.blockmap`，那是更新检查元数据，不用手工下载）。Windows 和 macOS 安装包暂未做代码签名，首次运行可能出现系统安全提示；Linux 同时提供 Debian、RPM 和 AppImage 包，Flatpak 目前提供 x86_64 版本。

Linux 包的可运行范围取决于系统库版本，RPM/AppImage 文件格式不代表兼容所有旧发行版。当前源码通过 GTK3 接入 X11/Wayland 的 RDP 文本剪贴板，无需安装 `xclip` 或 `wl-clipboard`；对应发布包仍需验证 GTK3 运行库和桌面会话访问，Flatpak 另需验收沙箱权限。

Debian 13 安装或覆盖升级：

```bash
sudo apt install ./OpenFinalShell-<版本>-debian13-amd64.deb
```

**升级不用卸载。** Windows 有两条路：

- **应用内自动更新**（安装版）：启动后与之后每 6 小时查一次，发现新版就在后台下载
  （NSIS 差量包，通常只下变化的几 MB），下完在设置 → 关于与状态栏亮一个标记。
  点「重启并安装」时，若还有活动会话/传输/转发，会先把**具体条数**摆给你看再确认 ——
  **软件绝不自己重启**。自动检查可以在设置 → 常规里关掉，手动检查按钮照旧可用。
- **直接盖装**：下新版安装包双击即可，不必先卸载，数据也不会丢
  （安装器升级时会给旧卸载器传 `--updated`，`deleteAppDataOnUninstall` 那条清理被跳过）。

Windows 免安装版通过下载新版替换；Linux 检查新版后打开 Releases，不在应用内提权安装。macOS 当前发布资产未提供自动更新 feed，请下载对应架构的 DMG/ZIP 更新。Android 提供 APK 下载、校验和系统安装流程。多实例下的 Windows 安装更新会先汇总各窗口活动，并协调退出。

## 技术栈

Electron 43 + React 18 + TypeScript · [ssh2](https://github.com/mscdex/ssh2) · [xterm.js](https://xtermjs.org/) · [CodeMirror 6](https://codemirror.net/) · Ant Design 5 · zustand · C++ / FreeRDP Worker

运行时依赖四个：`ssh2`、`iconv-lite`、`electron-log`、`electron-updater`。渲染层的库全是 devDependency，由 Vite 打成一个 bundle。

主要架构：

- **主进程存储与原生 RDP 分离**。数据库使用内置 `node:sqlite`，凭据使用 Electron `safeStorage`；RDP 由独立 C++ Worker 与 FreeRDP/WinPR 运行库提供。嵌入式 RDP 发布构建要求真实 FreeRDP，不能用协议模拟 Worker 替代。
- **渲染进程是纯视图**。`contextIsolation` + `sandbox` 全开，ssh2 / fs 只在主进程；能力经 preload 白名单暴露，IPC 入参一律 zod 校验。CSP 是 `script-src 'self'`（无 `unsafe-eval`、无 `blob:`）—— 这也是内置编辑器选 CodeMirror 而不是 Monaco 的决定性原因。
- **凭据引用（credentialRef）模式**。明文密码只在保存表单时单向进主进程，加密落盘后仅返回一个引用；渲染进程从来拿不到明文，也拿不到冲突检测用的文件基线。
- **IPC 契约唯一事实来源**是 `src/shared/ipc.ts`，main / preload / renderer 三层都只从那里取 channel 名与类型。
- **多语种**。语言注册表与资源位于 `src/shared/locales/`。简体中文/英文随 renderer 打包，其余语言按需加载；翻译规范见 [agent.md](agent.md)。
- **独立实例**。每个应用进程拥有自己的会话资源，通过本机控制通道协调配置变更和更新；控制消息不携带终端、文件或凭据内容。

代码结构：

```
src/shared    IPC 契约、共享类型与常量（禁止运行时依赖）
src/main      SSH / SFTP / RDP 会话 / AI / 监控 / 转发 / 存储 / 实例协调
src/preload   白名单桥
src/renderer  React 界面（features 按功能分目录，stores 用 zustand）
native        FreeRDP Worker、剪贴板与协议测试
android       Kotlin / Compose 原生客户端
shared-schema 跨桌面与 Android 的数据契约
```

### Android 原生客户端

仓库同时包含独立的 Kotlin Android 客户端（`android/`）。它不加载 Electron
或 Node.js，而是通过 Apache MINA SSHD、Jetpack Compose、Room 和 Android
Keystore 实现原生连接体验。跨端数据协议定义在 `shared-schema/`，保持现有
监控帧、端口流量、LAN Sync 和 v1/v2 导入导出格式兼容。

本地需要 JDK 17 和 Android SDK 35，设置 `JAVA_HOME` 与 `ANDROID_HOME`。仓库自带 Gradle Wrapper，会下载并校验 Gradle 8.10.2，无需全局安装 Gradle。Windows PowerShell：

```text
npm run android:generate-schema
.\android\gradlew.bat -p android :app:checkI18n testDebugUnitTest
.\android\gradlew.bat -p android :app:assembleDebug :app:assembleDebugAndroidTest
```

macOS/Linux 使用 `sh android/gradlew -p android` 执行相同任务。当前 Windows 开发机已通过 70 项 Android 单元测试和 API 26/35 模拟器各 12 项仪器测试，覆盖导航、数据迁移、凭据隔离及系统文件接口。四种 ABI 及 universal Debug APK、未签名 Release APK/AAB 和完整 lint 均通过；正式签名与实机功能验收另行记录。

Android 支持 API 26 及以上和 `arm64-v8a`、`armeabi-v7a`、`x86_64`、`x86`，另提供 universal APK。桌面端
`safeStorage`/Windows DPAPI 密文不能直接在 Android 解密，跨设备迁移请使用
口令保护的加密导出文件。GitHub Actions 会在 Android 相关变更时运行编译、
单元测试和 API 26/35 仪器测试；推送 `v*` 标签时，签名 APK/AAB 会上传到同一
Release。Android 发布需要配置 `ANDROID_KEYSTORE_B64`、
`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 和 `ANDROID_KEY_PASSWORD`
四个仓库 Secrets。Android 现有功能包括 SSH 终端、SFTP、监控、端口转发、连接管理、加密导入导出和局域网传送。本轮源码增加代理连接、SAF 传输、命令库、AI 助手和远程文本编辑，仍需完成真实服务与设备验收；暂不包含嵌入式 RDP 或多实例能力。详见 [Android 文档](android/README.md)。

## 开发

使用 Node.js 24 和 npm，先安装依赖再启动开发环境。开发机网络代理按自己的环境配置，不应把个人代理地址提交到仓库。

```bash
npm install
npm run dev
```

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式（主进程改动自动重启） |
| `npm run build` | 三层生产构建 |
| `npm run typecheck` | 主进程 + 渲染层类型检查 |
| `npm run check:i18n` | 多语种文案键对齐校验（N 种语言键全等 + 覆盖 + 无游离） |
| `npm test` | 单元 + 集成测试（自动起本地测试 SSH 服务器） |
| `npm run check:bundle` | 渲染进程产物的字节预算（需先 `build`） |
| `npm run package` | 打 Windows 安装包（NSIS + portable） |
| `npm run package:deb` | 在 Linux 上打 Debian 13 amd64 安装包 |
| `npm run check:deb` | 检查 deb 元数据、依赖、desktop entry 与安装路径 |
| `npm run package:dir` | 只打免安装目录，用于快速验证 |
| `npm run smoke:packaged` | 驱动打包产物跑端到端冒烟 |
| `npm run smoke:multi-instance` | Windows 真实多进程 SSH / SFTP / Vault / AI 隔离测试 |
| `npm run build:rdp-worker -- --platform win --arch x64 --require-freerdp` | 构建真实 Windows x64 RDP Worker；其他目标使用 `mac` / `linux` 和对应架构 |
| `npm run check:rdp-worker -- --platform win --arch x64 --require-freerdp` | 校验 Worker、运行库与发布能力 |
| `npm run icon` | 重新生成应用图标 |

跨平台构建不能复用 `node_modules`。真实 RDP Worker 需要 CMake、C++ 工具链及 FreeRDP/WinPR 开发依赖；按目标平台参考 [发布工作流](.github/workflows/build-windows.yml) 安装。未构建本地 Worker 时，`npm run dev` 仍可调试 SSH 和界面，但嵌入式 RDP 会提示 Worker 缺失。

浏览器调试：`npm run dev` 后直接打开 <http://localhost:5173>，渲染层在缺少 preload 时会启用 mock IPC（含模拟终端、假 SFTP 目录树、周期监控数据），便于纯 UI 迭代。

### 本地测试 SSH 服务器

没有可用的 Linux 主机时，用内置 fixture 起一个真实 SSH 服务：

```bash
node test/fixtures/testSshServer.mjs 2222
```

账号 `test` / `test123`（另有 `kbi` / `test123` 用于验证 keyboard-interactive）。它实现了 shell、SFTP 子系统、exec 通道（含假 `/proc` 输出）与三型端口转发，所以大部分功能都能在本机端到端验证。终端内支持 `echo`、`size`、`flood <MB>`（压测背压）、`ps1 <default|exotic>`（换提示符，
给命令历史的采集用 —— 见下面冒烟那一节）、`exit`。`OFS_FIXTURE_MAX_SESSIONS=2` 可以让它模拟一台把 `MaxSessions` 调小的低配服务器。

fixture 有两处**故意的局限**，别把它当真机：一次性命令（`env … sh -c <脚本>`）这条路上它只当镜子（把命令原样回显，用来断言引号经过 SSH 协议后一个字节都没变），所以 `rm -rf` 与 `tar` 的**语义**在它上面验不了；它也不通告任何 SFTP 扩展，所以 `posix-rename` 那条主路径走不到。

### 真实服务器验收

fixture 是按本客户端的预期实现的，有循环论证风险，所以另有几组连真实 OpenSSH 的用例（未设环境变量时自动跳过，`npm test` 在任何机器上都能跑）：

```bash
$env:OFS_TEST_HOST='1.2.3.4'; $env:OFS_TEST_PORT='22'
$env:OFS_TEST_USER='root';    $env:OFS_TEST_PASSWORD='...'
npx vitest run test/integration/realServer.test.ts test/integration/realServerAdvanced.test.ts
```

- `realServer.test.ts`：密码认证与指纹、中文/emoji 回显、pty resize、longname 属主解析、符号链接目标类型、上传下载往返与权限、监控数值与 `free`/`df`/`nproc` 独立读数对照、三型转发打通真实隧道、探测 `MaxSessions`
- `realServerAdvanced.test.ts`：私钥认证（临时装公钥后精确移除）、口令错误文案、GBK 双向转码、非 UTF-8 文件名标黄、断线自动重连、大文件吞吐
- `realServerProxy.test.ts`：经**真实代理软件**（Clash/v2ray 等）连真实服务器，另需 `OFS_TEST_PROXY_HOST` / `OFS_TEST_PROXY_PORT`
- `realServerBatch3.test.ts`：编辑远端文件 / 快速删除 / 打包下载 —— 这三样在 fixture 上一样都验不了。它同时把观测到的服务器事实打出来（tar 风味、TMPDIR、可用空间、`posix-rename` 有没有被通告、编辑前后的权限位与属主）

凭据只从环境变量读，不写进代码库；远端改动都在一个 `mktemp -d` 目录里，`afterAll` 无条件删掉。

**这套测试抓到过一个本地用例照不出来的致命 bug**：远端 GNU tar 打的包，成员名是文件系统的原始 UTF-8 字节，而 ustar 格式没有地方声明编码 —— Windows 上的 bsdtar 于是按当前 ANSI 代码页（CP936）解释，**每个非 ASCII 文件名都报 `Invalid empty pathname` 并让整个任务失败**。本地全绿是因为归档是 bsdtar 自己造的（自洽）。修法是解包与列成员都带 `--options hdrcharset=UTF-8`。

### 打包产物冒烟测试

```bash
node test/fixtures/testSshServer.mjs 2270
npm run package:dir
npm run smoke:packaged
```

用 CDP 连上打包后的真实应用，依次验证 preload 桥注入、`safeStorage` 可用、凭据不回传明文、SSH 握手、终端中文+emoji 回显、SFTP 浏览、监控采集、真实表单保存连接、导入导出面板可用 —— 能抓到只在打包环境才出现的问题（asar、preload 路径、原生依赖）。另外几步专门盯只有真实窗口能回答的事：

- **原生窗口按钮区**：Windows 的 `titleBarOverlay` 由 OS 绘制、永远盖在页面之上。静态扫描三种布局的可交互元素矩形，再用真实鼠标移动 hover 出 antd 的 tooltip 气泡量相交（这类 bug 真出过：「打开文件管理」被系统按钮切成了「打开」）
- **拖到文件夹行上传**：用 `Input.dispatchDragEvent` 注入带真实文件路径的拖拽，断言那一行底色真的变了、文件真的落进那个目录、且没有同时落进当前目录
- **内置编辑器**：严格 CSP + `file://` 下 CM6 起得来且 console 零 CSP 拒绝；语法着色产出多种不同颜色（只数 span 不够）；代码区可选中；根元素 CSS `zoom` 100%/150% 两档下点击落点都正确
- **输入法**：用 `Input.imeSetComposition` 造真实组词序列（`ni` → `nihao` → 提交「你好」），断言内容进了文档、没有拼音残留、只插了一遍
- **命令历史**：在真终端里用真按键敲一条命令 + 回车，断言它进了库（这一步验的是"采集读的是真 xterm 缓冲、
  真提示符、真光标列"，假缓冲的单测答不了）；`Ctrl+Shift+H` 浮出列表、点一条 → 断言命令回填到了命令行
  **且没有出现新的提示符**（fixture 每执行一条命令必然重打提示符，所以这条判据不依赖任何解析）；
  再关掉设置里的开关验证不再记新的、已有记录不动；最后走一遍「清空列表」的二次确认。
  另有一轮用 `ps1 exotic` 把提示符换成 `➜  ~ ` 再采一次 —— 默认提示符里有 `$ `，
  于是"提示符列"那条主路坏掉时退路会兜住、断言照样绿；exotic 提示符里没有任何退路认得的符号，
  **它一响，主路就是唯一能把命令切对的东西**
- **命令编辑器**：从界面点开（活动栏 → 快捷命令 → 铅笔按钮），单行发送断言终端回显且没有多余确认框、
  命令进了历史；再发一段两行的，断言**先弹确认框**、确认后两行都发出去了
  （单测只能证明代码里判了 `confirmMultilinePaste`，证不了它在真 antd 里弹得出来）
- **FinalShell 导入**：现造一个含 `conn/` 的临时目录（样本保留真实字段名与形状，主机与密文都是编的），
  经 `app:finalshellScan` → `app:finalshellImport` 落库，断言 `terminal_encoding: GBK` 映射成 `gbk`、
  `description` 进了备注、`parent_id` 重建成了分组层级，以及最要紧的那一条：
  **那条连接不许带密码引用**（密码解不出来，正确行为是留空；哪天有人接上一个猜的推导，这条会红）
- **保存的整条闸门循环**：fixture 不通告 `posix-rename`，所以每次保存必然先撞上"不支持原子替换"那道闸门 —— 取消后远端一个字节没变、确认后内容正确落地；从背后改一次远端再存，conflict 与 nonAtomic **两个框连着弹**（这正是把三道闸门拆成三个开关而不是一个 `force` 的意义）

> 注意：应用有单实例锁，跑之前先关掉开发模式的实例。

### 渲染进程的字节预算

渲染层依赖由 Vite 打包，`npm run check:bundle` 检查实际产物：JS ≤ 3.3MB、gzip ≤ 950KB、CSS ≤ 80KB。FreeRDP Worker 与原生运行库独立打包，不计入 renderer bundle。

三条反空转断言比阈值本身更重要：产物必须真的找到且 > 1MB（路径写错时"0 ≤ 阈值"永远成立）；JS 必须真的被 minify 过；CSS 那条卡得很紧是**故意的** —— 它同时是"编辑器不引入自带样式表"的护栏（Monaco 光 `editor.main.css` 就 412KB）。

生产 renderer 构建显式启用压缩；大小以当前构建的检查输出为准。

### 传输吞吐

SFTP 传输走**并发窗口**（同时保持 64 个 32KB 读/写请求在管道里），减少高延迟链路上的逐块等待。下面是在一台 RTT 220ms 的服务器上进行的历史基准（20MB），不代表所有版本、服务器或网络的速度保证：

| 实现 | 上传 | 下载 |
|---|---|---|
| 顺序 pipe（早期实现） | 0.16 MB/s | 0.04 MB/s |
| ssh2 内置 fastPut / fastGet | 1.05 MB/s | 0.06 MB/s |
| **并发窗口实现** | **2.0 MB/s** | **0.1 MB/s** |

下载三者都慢是因为那台服务器的**出口带宽**受限 —— 纯 SSH 数据通道（`cat` 大文件，完全不经 SFTP）同样只有 0.04 MB/s。判断下载慢是链路还是客户端问题，可以用 `node scripts/benchSftp.mjs 20` 对比。并发窗口仍完整支持暂停/继续/取消：暂停时停止发放新请求并等在途请求收尾，`.part` 里的数据保持连续，所以续传只需按字节偏移接上。

### 发布（GitHub Actions）

[桌面发布工作流](.github/workflows/build-windows.yml) 构建 Windows x64/ia32/ARM64、macOS x64/ARM64、Linux x64/ARM64 和 Flatpak x64，共 8 个打包任务。[Android 发布工作流](.github/workflows/android-release.yml) 同时生成签名 APK/AAB。

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

把 `X.Y.Z` 替换为待发布版本，并先同步 `package.json`、锁文件及应用内更新说明；可在 `docs/releases/vX.Y.Z.md` 补充发行说明。工作流校验 tag 与包版本一致，通过类型、语言、全量测试和 Windows 多进程冒烟后再打包。当前完整 Release 共 31 个文件：17 个桌面包、6 个 Android 包、3 个 Windows 更新 feed、3 个 blockmap 和 2 份校验和。

桌面工作流手动触发只生成 artifacts；Android 手动发布要求指定已有 tag。原生 Worker 的构建和依赖校验属于打包门禁，真实服务器/原生文件管理器的验收仍需对应平台环境。

三点踩过的坑：

- **`electron-builder.yml` 里不要给 `win.target` 写死 `arch`**。写了之后命令行的 `--x64` / `--ia32` 对安装包目标就会被忽略，每次调用把两个架构外加一个合体包全建一遍（实测单 job 产出 732MB、耗时翻倍）。注意 `--dir` 验证不出这个问题。
- **`artifactName` 里的 `${arch}` 不能省**，否则两个架构的产物同名互相覆盖。
- **合体安装包体积翻倍**（181MB vs 单架构 86/96MB），不需要 —— 所以 CI 按架构分开跑，并在构建后断言 `release/` 下恰好只有该架构的 2 个 exe。

---

## 已知限制

以下列出当前实现边界与尚未完成的能力，选择平台和工作流程时请以此为准。

**远程文件名只支持 UTF-8。** ssh2 对文件名做有损 UTF-8 解码，非 UTF-8 编码（如 GB18030）的文件名无法可靠还原，此类条目在列表中标黄且禁止操作。终端流的编码不受此限制（GBK 等经 iconv-lite 双向转码）。

**私钥格式**（以 ssh2 ^1.17 实测为准，见 `test/unit/privateKeyFormats.test.ts`）：支持 **OpenSSH 新格式**（`ssh-keygen` 默认产物，含加密私钥）与**传统 PEM**（`BEGIN RSA PRIVATE KEY`，含加密）；**不支持 PKCS#8**（`BEGIN PRIVATE KEY` / `BEGIN ENCRYPTED PRIVATE KEY`），用 `ssh-keygen -p -f <私钥> -m RFC4716` 转换即可。PuTTY `.ppk` 未验证。

**监控需要 Linux。** 采集基于 `/proc`，BSD/macOS 等会显示"暂不支持监控"，终端与文件管理不受影响。连接数取自 `/proc/net/sockstat`（内核已维护的聚合计数，读它与连接数多少无关）；按 TCP 状态的明细要遍历 `/proc/net/tcp`，所以只在每 5 个采集周期采一次，缺 `awk` 或超时时只是没有这几行。UDP 无连接概念，那一行统计的是**已打开的套接字**。

**凭据不能直接换机。** Windows 上 `safeStorage` 走 DPAPI，密文与当前系统用户绑定 —— 重装系统或换机后数据库里的密文无法解密。走"导出（勾含密码）→ 新机导入并填同一口令"这条路，导入时会用新机的 DPAPI 重新加密入库。

**Windows 凭据依赖系统密钥元数据。** `safeStorage` 使用的系统保护密钥保存在用户数据目录的 `Local State` 中，多实例会共享相同密钥来源。不要只复制或删除其中一个数据文件；已有密文而密钥元数据丢失时，程序会中止初始化，避免生成不匹配的替代密钥。迁移请使用加密导出。

**编辑远端文件的边界：**

- **属主/组/ACL/SELinux 标签不保留**。写回是"写临时文件 + 原子 rename"，rename 换 inode，这些属性跟着 inode 走。权限位（mode）是显式保留的。
- **软链会被解析成真身再编辑**（`/etc/nginx/sites-enabled/*` 全是软链），编辑完那条软链还是软链。编辑期间有人把软链重新指向别处的话，**保存会停下来报错**而不是打到旧真身上。
- 单文件上限 8MB、同时最多 10 个；**含 NUL 字节的文件一律拒绝**（含 UTF-16 文本 —— 往返一次极易损坏，宁可让你走下载-改-上传）。
- **当前编码解不干净的文件是只读的**（状态条上有"编码可能不对"）。里面有这个编码里不合法的字节，你看到的内容已经有字符被替换过，存回去会永久改写那些你从没看见的字节。换个编码重开即可。
- **打的字存不下去时会拒绝保存并点名那个字符**（在 GBK 文件里粘一个 emoji 就是这种情况）。iconv 对表示不了的字符不报错、悄悄换成 `?`，所以必须在写之前拦住。
- **混用行尾的文件，保存会把整个文件的行尾统一掉**（统一成状态条上显示的那一种），所以那种文件的往返不可能逐字节相同 —— 状态条上会先亮一个"行尾混用"。
- 服务器不通告 `posix-rename@openssh.com` 时会明确拦下来问你，退化路径是"原文件改名备份 → 新内容改名就位 → 删备份"；断在中间的话原内容以 `.ofsbak-` 开头留在同目录。
- **v0.2 起没有"用外部编辑器打开"了**：那条路（下载到 `%TEMP%` + 起一个 exe + 盯文件存盘）整条删掉。这不只是少一个功能 —— 远端文件的明文副本不再落到本机磁盘、子进程面收窄到一处、设置里那个"编辑器 exe 路径"（连同它导入配置时的提权链）一起消失；顺带那条老路最大的盲区也没了：编辑器"另存为"到别的路径时什么都不会上传、也不会报错。

**FinalShell 导入的边界：**

- **密码不会跟过来，这是刻意的。** 它的 `password` 字段 base64 解出来是 **8 字节随机头 +
  N×8 字节 DES 块**，密钥推导里混了客户端内置的常量。本项目试过 22 种不含常量的候选推导
  （头本身 / md5 / sha1 / 两者拼接 / `java.util.Random(头)` 派生，各配 DES-ECB 与 DES-CBC），
  **全部通不过 PKCS#5 padding 校验**。剩下的选择只有两个：拿一个猜的推导去解、把垃圾也照样
  加密入库（用户要等第一次连接失败才发现，且分不清是密码错还是导入错），或者承认解不出。
  取后者。代码里留了唯一的接入点（`decryptFinalShellPassword`）与那道准入校验
  （padding + UTF-8 往返 + 无控制字符），**接推导的人跳不过校验**，有护栏盯着。
- **导入的数据一律加密存储**：导入器不碰 vault、也不自己写 profiles 表，一律经 `saveProfile` ——
  本项目唯一的加密入口（明文只在内存里存在一瞬，`safeStorage` 加密后库里只有引用）。
  有一条用例直接去库里翻，断言 profiles 表的 JSON 里既没有密文也没有 `"password":` 这个键。
- **私钥认证要重新指定私钥文件**：FinalShell 把私钥存在它自己的密钥库里（记录里只有一个
  `secret_key_id`），导入后在"设置 → 代理与私钥"里存一条私钥、再到连接编辑里选上即可
  （存一次可被多台机器复用）。扫描时会告诉你有几条是这种。
- **代理与端口转发不导入**：`proxy_id` 指向它自己的代理记录，而转发列表的元素结构本项目
  没有样本可对照 —— 宁可报数让你手工补，不猜结构。
- **只导 SSH**（`conection_type` 100，注意那个拼写是它的）。RDP/VNC 之类计数后跳过。
- **id 不复用**：它的 id 是 16 位随机串，导入后一律换成本项目的 UUID，所以判重只能按
  "主机+端口+用户名"，可选跳过或一律新建。
- 上级分组不在所选目录里时，那条连接落到根目录并在结果里说明。

**自动更新的边界：**

- **第一次多半是全量。** electron-updater 的差量要拿本机缓存里的旧安装包做基准
  （`%LOCALAPPDATA%\openfinalshell-updater\`），而"自己去 Releases 下载装的那一版"
  不在那个缓存里。所以第一次自动更新大概率下整包，之后每一跳才吃到差量。
- **没有代码签名。** 更新包的可信度靠 HTTPS + `latest-*.yml` 里的 sha512（CI 会在打包后
  重算一次核对），不靠签名。这与现在"首次运行有 SmartScreen 提示"是同一件事的延续。
- **更新不切换 CPU 架构。** Windows 使用 `latest-x64.yml`、`latest-ia32.yml`、`latest-arm64.yml` 三份独立 feed，切换架构需手动选择对应安装包。
- **免安装版不自更新**，只提示。
- 安装会退出相关实例、断开会话、取消进行中的传输并停止转发，确认前会汇总活动数量。传输队列尚未跨重启持久化；应先完成重要传输，再安装更新。

**命令历史的边界：**

- **靠屏幕上那一行取命令，不是靠按键流**。按退格、按 ↑ 翻 shell 自己的历史、按 Tab 补全、粘贴——
  这几种都让"按键"不等于"命令"，而 shell 回显的那一行才是真相。切提示符优先用"你在这一行敲下第一个键时
  光标在第几列"（不需要认识提示符长什么样），量不到时退回认 `$ ` / `# ` / `% `。
- **两条都不成立时宁可不记**。提示符里既没有 `$`/`#`/`%`（例如 `➜  ~ ` 这类 oh-my-zsh 主题），
  又是这一行第一个键就直接回车的场合，那一条就不进历史 —— 把提示符（里面有主机名、路径，
  某些 PS1 还有 git 分支）当成命令存进一张持久化的表更糟。
- **全屏程序里完全不记**（vim / less / htop 一律是 alternate buffer）。不然历史会被你正在编辑的
  文件正文塞满，而那恰恰是最不该被存下来的东西。
- **口令类提问会跳过**：提示符那一段里出现 password / passphrase / 密码 / 口令 / secret / token
  就整条不记。不回显的那些（`sudo` 的密码）天然记不到。但这**不是万无一失**的 ——
  一个自定义的"请输入你的 API key:"就漏了，而 `mysql -pxxx` 这种口令写在命令行上的**会**被记下来。
  所以设置 → 终端里可以整个关掉，浮层里有「清空列表」，且历史不进导出文件。
- **回填不执行**，这是刻意的：列表里躺着的是你在生产服务器上敲过的原话，其中完全可能有
  `rm -rf`、`systemctl stop`。单击就执行等于把误点的代价定在事故那一档。
- 历史是**跨机器共用**的一份，不按连接切开 —— 换一台机器重复同一串操作正是最需要它的时候。
  同一条命令只占一行，所以 1000 条上限是"一年的日常运维命令"那个量级，不会被 `ls` 刷满。

**快速删除（`rm -rf`）的边界：**

- **拒绝非空路径段少于两级的路径**，也就是 `/`、`/etc`、`/root`、`/usr`、`/tmp`、`/home`… 一律删不了。这一条规则同时挡住了**所有**系统一级目录（包括将来才会出现的），代价是 `/data1` 这种把数据直接挂在一级目录下的用法用不了快速删除（走普通删除，照旧能用）。**这是刻意的限制，不要为了方便去放宽它**（有一条封条用例盯着这个数字）。
- **只对目录提供，且要求这一批全是目录**。单个文件用 `rm` 一点都不快（SFTP unlink 就一个往返），混选时整条禁用而不是"只删其中的目录" —— 一个 `rm -rf` 不该悄悄改变你选中的范围。
- **路径里不许有换行/回车**。不是转义问题（单引号里的换行是合法字面量），而是"哪几条没删掉"这个结果是**按行**从命令输出里解析的。这类文件请用普通删除。
- **不做 `~` 展开**。所有路径都被单引号包成字面量。
- `rm -rf` 对不存在的路径退 0，所以"已经没了"和"刚被删掉"在结果上不区分。真正的判据是同一条命令里附带的残留探测；拿不到退出码（中途断连）就明说"无法确认删除结果"。**三种情况都会刷新列表 —— 刷新后的列表才是事实来源。**
- 一次超过 64 条路径（或命令超过 8000 字符）会分批执行，确认框里会说明分了几批。
- 走的是**主连接**上一条临时 exec 通道，所以不会触发二次认证；代价是通道峰值多占一个（`MaxSessions` 很小的服务器上可能报"服务器拒绝新建通道"）。

**打包传输（tar）的边界：**

- **只对下载生效**。上传方向需要一步权限归一化才安全（本地 bsdtar 给每个 entry 记的是 mode 0777，以 root 解包就是 0777 照抄落地），那一步没做完之前不放出来。
- **不做 gzip**。SSH 自己有压缩；下载方向压缩等于拿**生产服务器**的 CPU 换钱，而真正要搬的负载（jar / 镜像 / `.gz` 日志）本来就压不动。
- **打包与解包期间进度是未知的**（两端 tar 都不吐进度）。进度条停在上次的百分比，由阶段名（"正在远端打包 / 正在本地解包"）承载含义 —— 不会编一个假百分比。
- **暂停会连临时包一起清掉**，所以"继续"是从重新打包开始的。
- **Windows 上解包会跳过符号链接**（没有 `SeCreateSymbolicLinkPrivilege`），其余文件全部解出并附一句"跳过 N 个符号链接"。两个方向都**不保留 xattr / ACL / SELinux 标签**，稀疏文件被展开，属主不保留。
- **中途断连可能在远端留下 `ofs-pack.XXXXXXXX` 临时包**。本机临时包按实例放在 `%TEMP%\ofs-pack\<实例 ID>` 下，各实例只清理自己的目录。
- **不支持多选打包**：一个目录 ⇒ 归档里恰好一个顶层项，多选时每个目录各走一次判定。
- 远端 tar 不兼容时退回逐文件；BusyBox tar 可用于下载打包。本地 tar 使用固定路径：Windows 为 `%SystemRoot%\System32\tar.exe`，macOS/Linux 为 `/usr/bin/tar` 或 `/bin/tar`；不通过 PATH 搜索，避免误用会改写路径的工具。
- **解包前会把归档成员名单整个过一遍**：拒绝绝对路径、盘符路径、任何拼法的 `..`、以及多于一个顶层项，不通过就一个字节都不解。注意 `tar -tf` 在 Windows 上按系统 ANSI 代码页输出成员名，所以那些检查一律只依赖 ASCII 字节。

**升级到 v0.1.6+ 会把"显示隐藏文件"打开一次**：该默认值从关改成开，而这个开关的旧值已显式存在库里，所以做了一次性迁移。工具栏那个眼睛按钮随时能关回去，关掉后不会再被掀开。

**RDP 平台边界**：Windows x64 的 Explorer 文件剪贴板和 WinMM 音频已有实现；macOS/Linux 已构建真实 Worker，但原生双向文件剪贴板与音频后端尚未完成。Windows x86/ARM64 不打包真实 Worker，使用系统客户端入口。详情见开头的平台支持表。

**AI 边界**：当前使用 OpenAI Chat Completions 兼容协议，不提供 OpenAI Responses / Anthropic 原生协议、自定义请求模板、自动执行服务器命令或持久化多轮会话。模型与图片能力以实际网关支持为准；系统安全存储不可用时无法保存 AI Token。

**当前未提供**：Telnet / 串口 / VNC、RDP 打印机/磁盘/摄像头/多显示器重定向、音频采集、与 OpenSSH `known_hosts` 文件互通、GSSAPI 认证、配置云同步、FinalShell 密码解密。普通数据导出与 LAN Sync 不包含 AI 服务配置、AI Token、AI 问答及托管私钥内容。

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 脚手架 · IPC 契约 · 安全基线 · 主题与布局壳 | ✅ |
| M1 | 加密凭据 · 连接管理 · SSH 会话 · 终端（批处理 + 背压） | ✅ |
| M2 | 多标签会话 · keyboard-interactive / agent 认证 · 断线重连 · 快捷命令 | ✅ |
| M3 | SFTP 浏览与传输队列（并发窗口 + 断点续传 + 拖拽） | ✅ |
| M4 | 实时服务器监控面板（CPU / 内存 / 网络 / 磁盘 / 连接数） | ✅ |
| M5 | 端口转发（本地 / 远程 / 动态 SOCKS5） | ✅ |
| M6 | 设置页 · 打包发布 · 性能与视觉打磨 | ✅ |
| v0.1.x | HTTP/SOCKS5 代理拨号 · SQLite 存储 · 数据导出导入 · 快速删除 · 打包下载 | ✅ |
| v0.2 | 内置编辑器接管"打开"，可改可存回；删掉外部编辑器整条路 | ✅ |
| v0.2.x | 命令历史：记终端里真正执行过的命令，浮层过滤 / 回填 / 清空，落库 | ✅ |
| v0.2.x | 命令编辑器：多行命令临时拼装 → 发到当前 / 所有会话 | ✅ |
| v0.2.x | 从 FinalShell 导入连接与分组（密码除外，见已知限制） | ✅ |
| 已实现 | SFTP 同名冲突处理、跟随终端目录、独立编辑器窗口、双延迟及端口流量 | ✅ |
| v0.30.x | 嵌入式 FreeRDP 桌面、自适应显示；Windows x64 文件拖放/双向粘贴和音频 | 已提供，平台差异见支持表 |
| v0.30.x | AI 服务配置、模型列表、图片检测、流式/非流式响应、命令复制与填入 SSH | ✅ 桌面端 |
| v0.30.x | Windows 多实例设置开关、运行态隔离、配置共享及更新协调 | ✅ Windows |
| 已实现 | Windows 安装版应用内更新、Android 签名 APK/AAB 发布 | ✅ |

待完善：macOS/Linux 原生 RDP 文件剪贴板与音频、这些平台的多实例验收、Windows x86/ARM64 嵌入式 Worker、Android AI/RDP、跳板机 ProxyJump、主密码保险库、传输队列持久化、上传方向打包传输和快捷键改键。此列表不代表交付日期或已开放能力。

## 许可

MIT

连接位置标记里的国旗图形取自 [Twemoji](https://github.com/twitter/twemoji)（Twitter，图形部分 CC-BY 4.0），已内联为离线 SVG。
