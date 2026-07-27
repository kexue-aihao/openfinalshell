# openfinalshell

开源 FinalShell —— 全功能、美观 UI 的桌面 SSH 客户端：**SSH 终端 + SFTP 文件管理 + 实时服务器监控** 三合一，外加端口转发、快捷命令与加密凭据存储。

## 功能

- **连接管理**：分组树、搜索、右键菜单、复制连接、8 色标签；密码/私钥口令加密存储
- **多标签终端**：xterm.js（WebGL 渲染）、真彩色、Unicode 11 宽字符、中文/emoji 对齐、Ctrl+F 查找、选中即复制、右键粘贴、多行粘贴确认、IME 友好
- **会话健壮性**：keyboard-interactive 与 SSH Agent 认证、老设备算法兼容开关、指数退避自动重连（重连后终端缓冲保留、监控与转发自动接回）
- **经代理连接**：按连接配置 HTTP CONNECT 或 SOCKS5 代理（支持认证），域名交给代理解析；报错区分"代理问题"与"服务器问题"
- **SFTP 文件管理**：连上即自动展开的下方分屏、默认显示隐藏文件、虚拟表格（万级文件不卡）、
  拖入上传（拖到某个目录行上就传进那个目录）、传输队列（暂停/继续/取消/断点续传）、权限编辑、
  右键菜单（行与空白处共用一份，按有无选中项禁用）、新建文件/文件夹、
  **快速删除**（在服务器上跑 `rm -rf` 删整棵目录树，比逐个删快几个数量级；只对目录提供、独立的二次确认、
  确认框里原样列出将要执行的那条命令）
- **打包传输**（默认关，右键菜单里的勾选项）：下载整个目录时先在远端打成一个 tar、传一个文件、再本机解包，
  上千个小文件能快几个数量级。是**建议性**的 —— 文件数太少 / 远端没有 tar 或 mktemp / 空间不够 /
  与冲突策略不相容时自动改回逐文件，并在那条任务上写明原因。目前只对下载生效
- **直接编辑远端文件**：右键「打开」（或把双击行为设成"编辑"）把文件落到本地临时目录、
  用系统默认程序或你指定的编辑器打开，**存盘即写回远端**。
  写回走 `posix-rename` 原子替换、保留原权限；远端在编辑期间被别人改过会拦下来让你选，
  服务器不支持原子替换、或内容突然缩得很短（多半是编辑器还没写完）同样先问再动
- **实时监控**：连上即自动展开（可按连接关掉）。CPU（含每核）/ 内存 / Swap / 网络 /
  磁盘容量与 IO / 进程 Top / TCP 与 UDP 连接数（含 TIME_WAIT、ESTABLISHED、LISTEN 明细），2 秒刷新
- **端口转发**：本地(-L)、远程(-R)、动态(SOCKS5)，可随连接自动启动、断线自动恢复
- **快捷命令**：分组管理、一键发送到当前或全部终端、`{{host}}`/`{{user}}`/`{{port}}` 占位符
- **深浅主题**：6 套终端配色、8 种强调色、界面缩放；中英双语
- **数据导出 / 导入**：设置 → 安全与数据。导出连接/分组/快捷命令/转发/已信任主机/界面设置为 JSON；
  勾选"含已保存的密码"时用导出口令重新加密（scrypt + AES-256-GCM），不勾则文件里没有任何密码。
  导入可逐项勾选、可选同名数据的处理方式（跳过 / 覆盖 / 另存为副本），是**换机迁移的正式路径**。
  **卸载会清空本机数据**（`deleteAppDataOnUninstall`），卸载前请先导出

## 技术栈

Electron 43 + React 18 + TypeScript · [ssh2](https://github.com/mscdex/ssh2) · [xterm.js](https://xtermjs.org/) · Ant Design 5 · zustand · ECharts

设计取向：

- **零 native 硬依赖**：数据落 SQLite 但用的是 **Electron/Node 内置的 `node:sqlite`**，凭据用内置 `safeStorage`，SOCKS5 自实现 —— 不引 better-sqlite3/argon2/keytar/socksv5。这不只是洁癖：`better-sqlite3` 这类原生模块在 32 位（ia32）上要现编，会直接掐死 x86 产物。
- **渲染进程是纯视图**：`contextIsolation` + `sandbox` 全开，ssh2/fs 只在主进程；能力经 preload 白名单暴露，IPC 入参 zod 校验。
- **凭据引用（credentialRef）模式**：明文密码只在保存表单时单向进主进程，加密落盘后仅返回引用；**已存密码永不回传渲染进程**，日志字段自动脱敏。
- **数据存 SQLite 单文件**（`userData/config/openfinalshell.db`，WAL）：集合类数据用真表、深层嵌套的领域对象存 JSON 列。改一条连接不再重写整个文件，多实例同时运行也不会互相覆盖。首次启动会把 v0.1.0 的 JSON 配置导入并把原文件改名 `*.migrated`（保留而非删除）。
- **终端通路专门优化**：主进程 8ms/256KB 双阈值批处理下行数据，配合 `bytesInFlight` 水位做背压 —— `cat` 大文件不会撑爆内存，Ctrl+C 立即生效。

## 开发

```bash
npm install
npm run dev
```

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式（主进程改动自动重启） |
| `npm run build` | 三层生产构建 |
| `npm run typecheck` | 主进程 + 渲染层类型检查 |
| `npm run check:bundle` | 渲染进程产物的字节预算（需先 `npm run build`，见下） |
| `npm test` | 单元测试 + 集成测试（自动起本地测试 SSH 服务器） |
| `npm run icon` | 重新生成应用图标 |
| `npm run package` | 打 Windows 安装包（NSIS + portable） |
| `npm run package:dir` | 只打免安装目录，用于快速验证 |
| `npm run smoke:packaged` | 驱动打包产物跑端到端冒烟（见下） |

### 本地测试 SSH 服务器

没有可用的 Linux 主机时，用内置 fixture 起一个真实 SSH 服务：

```bash
node test/fixtures/testSshServer.mjs 2222
```

账号 `test` / 密码 `test123`（另有 `kbi` / `test123` 用于验证 keyboard-interactive）。它实现了 shell、SFTP 子系统、exec 通道（含假 `/proc` 输出）与三型端口转发，因此整套功能都能在本机端到端验证。终端内支持 `echo`、`size`、`flood <MB>`（压测背压）、`exit`。

一次性命令（`env … sh -c <脚本>`）这条路上，fixture **只当镜子**：把收到的命令原样回显，
好让测试断言"那段引号经过 SSH 协议之后一个字节都没变"。它没有真 shell、也没有真文件系统，
所以 `rm -rf` 的**语义**在它上面无法被验证 —— 那些归真机验收。

`OFS_FIXTURE_MAX_SESSIONS=2` 可以让它模拟一台把 sshd `MaxSessions` 调小的低配服务器
（超过上限的 session 通道一律拒掉）。这条以前只能"找一台那样的机器手工验"，于是一直没人验；
封顶放进 fixture 之后 `test/integration/maxSessions.test.ts` 就是普通用例了 ——
它第一次跑就抓到 `channelOpenError()` 全项目五个开通道的地方只有一个在用，
另外四个都把 ssh2 的 `(SSH) Channel open failure: open failed` 原话透给了用户。

### 渲染进程的字节预算

渲染进程的库（react / antd / echarts / @xterm）全是 **devDependency**，由 Vite 打进一个
bundle —— 这条路不碰"3 个运行时依赖 / 零 native 依赖"那条红线（`app.asar` 里的
`node_modules` 只有 8 个包：3 个运行时依赖 + ssh2 的 5 个传递依赖），代价是**没人看得见它在长**。
`npm run check:bundle` 把它变成一个会报红的事实：

- JS ≤ 3.3 MB、gzip ≤ 950 KB、**CSS ≤ 80 KB**
- 三条反空转断言比阈值本身更重要：产物必须真的找到且 > 1 MB（路径写错时"0 ≤ 阈值"永远成立）；
  JS 必须真的被 minify 过（按"字节/行"判）；CSS 那条卡得很紧是**故意的**——
  它同时是"编辑器不引入自带样式表"的护栏（Monaco 光 `editor.main.css` 就 412 KB）

顺带修掉一处：electron-vite 的 renderer 预设把 `minify` 写死成 `false`。
覆盖它之后实测 4,560,893 → 2,240,967 字节，`app.asar` 从 5,990,521 → 3,663,301。

### shell 命令的转义（`src/main/ssh/shellQuote.ts`）

发到远端的每一条命令都包成 `env LC_ALL=C LANG=C sh -c '<整段脚本>'`，变量部分逐个过 `shQuote`
（POSIX 单引号，只处理 `'`，反斜杠原样保留）；路径另有一道 `assertSafeRemotePath`
（必须绝对、不许 `.`/`..`、不许换行）。这一层的测试刻意做成**三层互相校验**，
因为一张手写期望值的表最危险的失效方式是"我算错的和实现错的一模一样"：

1. 精确字符串表（30 行）；
2. 测试里**另写一遍**的 POSIX 反引号解析器当 oracle，断言能逐层剥回原值，
   且**没有任何字节漏在引号外**（漏出来就是注入本身）；
3. 本机有 POSIX sh（Linux/macOS，或 Windows 上 Git for Windows 自带的那个）时，
   把产物交给真 shell 跑一遍 —— 顺便验证第 2 层那个 oracle 自己是对的。

第 3 层必须**把脚本写进文件再 `sh <文件>`**，不能 `sh -c <命令串>`：Windows 上 Node 要把参数
拼成一条命令行、MSYS 那侧再解析一次，反斜杠会在这中间被吃掉。那是宿主参数传递的问题，
与我们的转义无关（真实路径是 ssh2 把命令原样当字节发出去）。

### 真实服务器验收

内置 fixture 是按本客户端的预期实现的，有循环论证风险，所以另有两组连真实 OpenSSH 的验收用例
（未设环境变量时自动跳过，`npm test` 在任何机器上都能跑）：

```bash
$env:OFS_TEST_HOST='1.2.3.4'; $env:OFS_TEST_PORT='22'
$env:OFS_TEST_USER='root';    $env:OFS_TEST_PASSWORD='...'
npx vitest run test/integration/realServer.test.ts test/integration/realServerAdvanced.test.ts
```

- `realServer.test.ts`：密码认证与 hostkey 指纹、中文/emoji 回显、pty resize、
  真实 longname 的属主解析、符号链接目标类型、上传下载往返与文件权限、
  监控数值与 `free`/`df`/`nproc` 独立读数对照、三型端口转发打通真实隧道、探测 sshd MaxSessions
- `realServerAdvanced.test.ts`：私钥认证（临时装公钥后精确移除）、口令错误与缺口令的文案、
  GBK 双向转码、非 UTF-8 文件名标黄、断线自动重连、大文件传输吞吐
- `realServerProxy.test.ts`：经**真实代理软件**（Clash/v2ray 等）连真实服务器，
  额外需要 `OFS_TEST_PROXY_HOST` / `OFS_TEST_PROXY_PORT`（可选 `_USER`/`_PASSWORD`，
  用 `OFS_TEST_PROXY_KINDS='socks5'` 可只测一种协议）
- `realServerBatch3.test.ts`：编辑远端文件 / 快速删除 / 打包下载。这三样在 fixture 上
  **一样都验不了** —— fixture 不通告任何 SFTP 扩展（posix-rename 那条主路径没走过）、
  exec 只是面镜子（`rm -rf` 与 `tar` 的语义无从验）、也没有真实的权限/umask/软链/`df` 输出。
  它同时把观测到的服务器事实打出来（tar 风味、TMPDIR、可用空间、posix-rename 有没有被通告、
  编辑前后的权限位与属主），排查时这些数比断言本身更有用。

凭据只从环境变量读，不写进代码库。会在远端 `/tmp` 建临时文件并在用例内删除；
私钥用例会往 `authorized_keys` 追加一行测试公钥并在结束时精确移除（先做备份）。
`realServerBatch3` 的全部改动都在一个 `mktemp -d /tmp/ofs-acc.XXXXXXXX` 里，afterAll 无条件删掉。

**这套测试立刻抓到了一个本地测试照不出来的致命 bug**：远端 GNU tar 打的包，成员名是文件系统
的原始 UTF-8 字节，而 ustar 格式没有地方声明编码 —— bsdtar 在 Windows 上于是按当前 ANSI
代码页（CP936）去解释它们，结果**每个非 ASCII 文件名都报 `Invalid empty pathname` 并让整个
任务失败**。本地用例全绿是因为归档是 bsdtar 自己造的（自洽），照不出这一层。
修法是解包与列成员都带上 `--options hdrcharset=UTF-8`；回归用例改用 MSYS 的 GNU tar 造包。

### 打包产物冒烟测试

```bash
node test/fixtures/testSshServer.mjs 2270
npm run package:dir
npm run smoke:packaged
```

它用 CDP 连上打包后的真实应用，依次验证 preload 桥注入、`safeStorage` 可用、凭据不回传明文、SSH 握手、终端中文+emoji 回显、SFTP 浏览、监控采集、真实表单保存连接、设置页「安全与数据」面板可用 —— 能抓到只在打包环境才出现的问题（asar、preload 路径、原生依赖）。

导入/导出要弹系统文件对话框，CDP 关不掉它，所以冒烟只验证到"面板渲染 + IPC 通路可达"
（用一个假 token 调 `app:importData`，期望被服务层拒绝而不是卡在参数校验或未注册）；
导入的语义（冲突策略、凭据引用归属、指纹不被覆盖、坏条目跳过）由 `test/unit/importData.test.ts` 覆盖。

还有两步专门盯**原生窗口按钮区**：Windows 的 `titleBarOverlay` 由 OS 绘制、永远盖在页面之上，
落进那块矩形的东西会被压住且点不到。判定一律用 `navigator.windowControlsOverlay` 的实际矩形而非
硬编码尺寸，并且会在矩形退化（按钮区宽 0）时直接报错 —— 否则"永远不相交"会让检查一直假绿。

- **静态**：扫描可交互元素自己的矩形，覆盖主界面、连接编辑抽屉、设置弹窗三种布局。
- **hover 后**：静态扫描抓不到 tooltip —— antd 的气泡是 hover 才挂到 body 的 portal，
  扫描那一刻 DOM 里没有它。所以另有一步用 CDP 注入真实鼠标移动，逐个 hover 终端右上角悬浮工具条
  与 `Ctrl+F` 查找条上的按钮，量气泡矩形与按钮区求交。这类 bug 真出过：工具条贴在标题栏下方，
  Tooltip 默认朝上弹，「打开文件管理」被系统按钮切成了「打开」（v0.1.2，见
  `components/TitlebarSafeTooltip.tsx`）。

这类问题只在真实窗口里可见 —— 单元测试和浏览器 mock 模式都抓不到。

还有一步盯**拖到文件夹行上传**：用 CDP 的 `Input.dispatchDragEvent` 注入一个带真实文件路径的
拖拽，断言那一行的底色与阴影**真的变了**（比对自己拖拽前的基线，不是比对隔壁行）、
文件真的落进那个目录、并且**没有**同时落进当前目录。不用合成 `new DragEvent`：
合成 `DataTransfer` 里的 `File` 没有磁盘路径，`webUtils.getPathForFile` 返回空串，
`handleDrop` 在"不支持的拖拽内容"那一支就返回了 —— 落点那行代码根本不会执行，测出来的绿是假的。
这一步能抓的核心问题只有真浏览器能回答：`.dropRow > .ant-table-cell` 得在 antd **虚拟**表格的
DOM 上命中（虚拟模式下行与单元格是 div 而不是 tr/td，中间多一层包裹就静默不亮）。

> 注意：应用有单实例锁，跑之前先关掉开发模式的实例。

### 传输吞吐

SFTP 传输走**并发窗口**（同时保持 64 个 32KB 读/写请求在管道里），而不是顺序 pipe ——
顺序写每块都要等一次 ACK，在高延迟链路上会被 RTT 打死。在一台 RTT 220ms 的境外服务器上实测（20MB）：

| 实现 | 上传 | 下载 |
|---|---|---|
| 顺序 pipe（早期实现） | 0.16 MB/s | 0.04 MB/s |
| ssh2 内置 fastPut / fastGet | 1.05 MB/s | 0.06 MB/s |
| **当前实现（并发窗口）** | **2.0 MB/s** | **0.1 MB/s** |

下载三者都慢是因为那台服务器的**出口带宽**受限 —— 纯 SSH 数据通道（`cat` 大文件，完全不经 SFTP）
同样只有 0.04 MB/s，客户端已经比原生实现更快。判断下载慢是链路还是客户端问题，可以用
`node scripts/benchSftp.mjs 20` 对比，或直接在服务器上 `cat` 一个大文件看纯通道速度。

并发窗口仍然完整支持暂停/继续/取消：暂停时停止发放新请求并等在途请求收尾，
`.part` 里的数据保持连续，因此续传只需按字节偏移接上。

### 发布（GitHub Actions）

[`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml) 只构建 Windows 的
**x64** 与 **ia32（x86）**：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

推 `v*` tag 即触发：先跑类型检查 / i18n 校验 / 全量测试，再按架构分别打包，
最后建 Release 并上传 4 个安装包与 `SHA256SUMS.txt`。手动触发（workflow_dispatch）
只产出 artifact，不发 Release。

三点踩过的坑：

- **`electron-builder.yml` 里不要给 `win.target` 写死 `arch`**。写了之后命令行的 `--x64` / `--ia32`
  对安装包目标就会被忽略，每次调用都把两个架构、外加一个双架构合体包全建一遍
  （实测单个 job 产出 732MB、耗时翻倍）。不写 `arch` 则完全由命令行决定，不给则只出宿主架构。
  注意 `--dir` 验证不出这个问题 —— 它只跑打包、不跑安装包目标。
- **`artifactName` 里的 `${arch}` 不能省**，否则两个架构的产物同名互相覆盖，只剩后构建的那个。
- **合体安装包体积翻倍**（181MB vs 单架构 86/96MB），不需要。所以 CI 按架构分开跑，
  并在构建后断言 `release/` 下恰好只有该架构的 2 个 exe。

工作流还会校验 tag 与 `package.json` 的版本一致（产物文件名取自后者），
不一致直接在打包前失败，免得发出一个"v0.2.0 的 Release 里装着 0.1.0 的安装包"。

### 经代理连接

连接编辑抽屉 → **代理**：选 HTTP 或 SOCKS5，填代理地址（如 `127.0.0.1:7890`），需要认证时填用户名密码
（密码同样只存 Vault 引用，不回传渲染进程）。目标地址一律交给代理解析 —— 本机解析不了的内网域名也能连。

协议实现在 [`src/main/ssh/proxyDial.ts`](src/main/ssh/proxyDial.ts)，握手完成后把多读到的字节 `unshift`
回读缓冲再交给 ssh2：目标服务器的版本 banner 常与代理应答在同一个 TCP 段到达，丢了就会卡死在
"Connection lost before handshake"。代理阶段的报错独立成 `ProxyError` 原样透出，
不会被翻译成 SSH 的"目标主机端口未开放"之类误导文案。

离线验证用 `test/unit/proxyDial.test.ts`（真实 TCP 假代理跑协议编码）与
`test/integration/proxyConnect.test.ts`（假代理 + fixture sshd，断言"确实走了代理"而非只是连上）。

### 浏览器调试模式

`npm run dev` 后直接用浏览器打开 <http://localhost:5173>，渲染层在缺少 preload 时会启用 mock IPC（含模拟终端、假 SFTP 目录树、周期监控数据），便于纯 UI 迭代。

## 已知限制

- **仅支持 UTF-8 的远程文件名**：ssh2 对文件名做有损 UTF-8 解码，非 UTF-8 编码（如 GB18030）的文件名无法可靠还原，此类条目在文件列表中标黄且禁止操作。终端流的编码不受此限制（GBK 等经 iconv-lite 双向转码）。
- **私钥格式**（以 ssh2 ^1.17 实测为准，见 `test/unit/privateKeyFormats.test.ts`）：
  支持 **OpenSSH 新格式**（`ssh-keygen` 默认产物，含加密私钥）与**传统 PEM**（`BEGIN RSA PRIVATE KEY`，含加密）。
  **不支持 PKCS#8**（`BEGIN PRIVATE KEY` / `BEGIN ENCRYPTED PRIVATE KEY`）——
  用 `ssh-keygen -p -f <私钥> -m RFC4716` 转换即可。PuTTY `.ppk` 未在本项目验证。
- **监控需要 Linux**：采集基于 `/proc`，BSD/macOS 等系统会显示"暂不支持监控"，终端与文件管理不受影响。
  连接数取自 `/proc/net/sockstat`（内核已维护的聚合计数，读它与连接数多少无关）；
  按 TCP 状态的明细要遍历 `/proc/net/tcp`，所以只在每 5 个采集周期采一次，
  且缺 `awk`/超时时只是没有这几行，不影响总数。UDP 无连接概念，那一行统计的是**已打开的套接字**。
- **升级到本版会把"显示隐藏文件"打开一次**：该默认值从关改成开，而这个开关的旧值已显式存在库里，
  只改默认值对老用户不生效，所以做了一次性迁移。代价是会覆盖"当初主动关掉"的选择 ——
  工具栏那个眼睛按钮随时能关回去，关掉后不会再被掀开。
- **凭据迁移**：Windows 上 `safeStorage` 走 DPAPI，密文与当前系统用户绑定 —— 重装系统或换机后数据库里的密文无法解密。
  换机流程：旧机「设置 → 安全与数据 → 导出」并勾选含密码（那一段用导出口令重新加密，不依赖 DPAPI），
  新机「选择文件导入…」并填同一口令，导入时会用新机的 DPAPI 重新加密入库。
  没勾含密码、或导入时不填口令也能导入连接，只是首次连接会提示输入密码。
- **已知风险：首次保存密码后立刻被强杀，那批密码会永久解不开。**
  `safeStorage` 在 Windows 上用的是 Chromium 的 OSCrypt：真正的 AES 密钥随机生成后写在
  用户数据目录的 `Local State` 里（本身受 DPAPI 保护），而这个文件是延迟落盘的。
  首次调用加密与落盘之间若进程被杀（崩溃、任务管理器结束进程），密钥就丢了 ——
  下次启动会生成新密钥，那段时间保存的密文再也解不开。
  目前的表现是"连接时又来问密码"，不会有明确提示；重新输入并勾选记住即可恢复。
- **编辑远端文件的几条边界**（都是有意为之，不是没做完）：
  - **属主/组/ACL/SELinux 标签不保留**。写回是"写临时文件 + 原子 rename"，rename 换 inode，
    这些属性跟着 inode 走。权限位（mode）是显式保留的，属主类属性无法在不 chown 的前提下保住。
  - **编辑器"另存为"到别的路径 → 什么都不会上传，也不会报错。**这是本功能最大的盲区：
    我们监视的是那个临时文件，你把内容存到别处，它就一直没变过。
  - **软链会被解析成真身再编辑**（`/etc/nginx/sites-enabled/*` 全是软链），
    所以编辑完那条软链还是软链。但**编辑期间**有人把软链重新指向别处的话，
    这次保存仍然会打到打开时的那个真身上。
  - 单文件上限 2MB、同时最多 20 条；**含 NUL 字节的文件一律拒绝**（含 UTF-16 文本 ——
    经普通编辑器往返极易损坏，宁可让你走下载-改-上传）。
  - 外部编辑器**只接受 `.exe` 的绝对路径，且只能从设置里的文件对话框选**：
    `.bat`/`.cmd` 要经 cmd.exe 解释执行（等于把 shell 请回来）、裸名字会让当前工作目录里
    的同名程序胜出、UNC 路径意味着每次存盘都从别人的共享起进程。
    导入的配置文件里带这个字段也不会生效（会在导入结果里说明）。
  - 编辑期间**远端文件的明文副本会落在 `%TEMP%`**（0600，Windows 上这个权限位没有意义）。
    退出应用时清、下次启动时清掉上次崩溃留下的。介意的话别用它编辑 `shadow` 这类文件。
  - 服务器不通告 `posix-rename@openssh.com` 时会明确拦下来问你，退化路径是
    "原文件改名备份 → 新内容改名就位 → 删备份"；断在中间的话原内容以 `.ofsbak-` 开头留在同目录。
- **快速删除（`rm -rf`）的几条边界**：
  - **拒绝非空路径段少于两级的路径**，也就是 `/`、`/etc`、`/root`、`/usr`、`/tmp`、`/home`… 一律删不了。
    这一条规则同时挡住了**所有**系统一级目录（包括将来才会出现的），代价是 `/data1` 这种把数据
    直接挂在一级目录下的用法用不了快速删除 —— 走普通删除，照旧能用。
    **这是刻意的限制，不要为了方便去放宽它**（`test/renderer/sftpFastDeleteWiring.test.ts` 里有一条封条用例盯着这个数字）。
  - **只对目录提供，且要求这一批全是目录**。单个文件用 `rm` 一点都不快（SFTP unlink 就一个往返），
    混选时整条禁用而不是"只删其中的目录"—— 一个 `rm -rf` 不该悄悄改变你选中的范围。
  - **路径里不许有换行/回车**。不是转义问题（单引号里的换行是合法字面量），而是"哪几条没删掉"
    这个结果是**按行**从命令输出里解析的，含换行的名字会把它解析歪。这类文件请用普通删除。
  - **不做 `~` 展开**。所有路径都被单引号包成字面量，`~` 就是一个字符。
  - `rm -rf` 对不存在的路径退 0，所以"已经没了"和"刚被删掉"在结果上不区分。
    真正的判据是同一条命令里附带的残留探测；探测报了残留就列出来，退出码拿不到（中途断连）
    就明说"无法确认删除结果，请刷新后核对"。**三种情况都会刷新列表 —— 刷新后的列表才是事实来源。**
  - 一次超过 64 条路径（或命令超过 8000 字符）会分批执行，确认框里会说明分了几批。
  - 这条命令走的是**主连接**上一条临时的 exec 通道，所以一次删除不会触发二次认证；
    代价是通道峰值多占一个（`MaxSessions` 很小的服务器上可能报"服务器拒绝新建通道"）。
- **打包传输（tar）的几条边界**：
  - **只对下载生效**。上传方向需要一步权限归一化才安全（本地 bsdtar 给每个 entry 记的是
    mode 0777，以 root 解包就是 0777 照抄落地），那一步没做完之前不放出来。
  - **不做 gzip**。SSH 自己有压缩；下载方向压缩等于拿**生产服务器**的 CPU 换钱，
    而真正要搬的负载（jar / 镜像 / `.gz` 日志）本来就压不动。
  - **打包与解包期间进度是未知的**（远端 tar 不吐进度，本地 tar 也不吐）。进度条停在上次的
    百分比，由阶段名（"正在远端打包 / 正在本地解包"）承载含义 —— 不会编一个假百分比。
  - **暂停会连临时包一起清掉**，所以"继续"是从重新打包开始的。取舍：留着能省一次打包，
    但一个被永久暂停的任务就在远端 `/tmp` 里留下一个大文件。
  - **Windows 上解包会跳过符号链接**（没有 `SeCreateSymbolicLinkPrivilege`），
    其余文件全部解出，任务成功并附一句"跳过 N 个符号链接"。硬链接尽力而为。
  - 两个方向都**不保留 xattr / ACL / SELinux 标签**，稀疏文件被展开，属主不保留。
  - **中途断连会在远端留下一个 `ofs-pack.XXXXXXXX` 孤儿**（名字可识别，`/tmp` 有发行版清理）。
    正常路径下它由 SFTP unlink 清掉。本机那份临时包放 `%TEMP%\ofs-pack`，启动时整目录清扫。
  - **不支持多选打包**：一个目录 ⇒ 归档里恰好一个顶层项，这正是"解包目标"与"顶层检查"
    能写成一行的原因。多选时每个目录各走一次判定。
  - `df` 看不到配额，所以打包仍可能撞 ENOSPC（按普通失败处理并清理）。
  - 远端 tar 认不出来（toybox 之类）就退回逐文件；BusyBox 的 tar 下载方向可用。
  - 本机必须有 `%SystemRoot%\System32\tar.exe`（**Windows 10 1803 或更高**）。
    **绝不走 PATH** —— 开发机上 `where tar` 命中的第一个是 Git 自带的 MSYS GNU tar，
    它会做路径改写，行为与 System32 的 bsdtar 完全不同。
  - **文件名在 Windows 上非法时，bsdtar 会自己就地改名**（实测：`a:b.txt` → `a_b.txt`，
    `con` 与 `trailing.` 原样落地，退出码 0、没有任何警告）。所以不会失败，
    但极少数这类名字经打包与经逐文件下载得到的本地文件名可能**不完全一致**
    （逐文件走的是 `sanitizeLocalName`：`con` → `_con`）。
  - **解包前会把归档成员名单整个过一遍**：拒绝绝对路径、盘符路径、任何拼法的 `..`、
    以及多于一个顶层项，不通过就一个字节都不解。libarchive 自己也拒 `..`（实测
    `app/..\..\evil.txt` 被它报 `Path contains '..'` 且哪儿都没落），两道防线各有用例盯着。
    ⚠️ **`tar -tf` 在 Windows 上按系统 ANSI 代码页输出成员名**（本机 CP936），
    也就是说列出来的名字读不懂 —— 所以那些检查一律只依赖 ASCII 字节，
    顶层名也只在它是纯 ASCII 时才做身份核对（否则只保证"唯一顶层"）。
  - **解包与列成员都带 `--options hdrcharset=UTF-8`**，少了它非 ASCII 文件名一个都解不出来
    （远端 GNU tar 存的是原始 UTF-8 字节，ustar 没地方声明编码，bsdtar 会按 ANSI 代码页解释，
    每个非 ASCII 成员都报 `Invalid empty pathname`）。这条是真机验收抓出来的，
    本地用例当时全绿 —— 因为归档是 bsdtar 自己造的、自洽。
    万一某个老 bsdtar 不认这个选项，会去掉它重跑一次（那时非 ASCII 名字仍然会失败）。
- **导入不覆盖已信任的主机指纹**：文件里的指纹与本机记录不一致时保留本机记录并在结果里说明 ——
  覆盖等于替用户吞掉中间人告警。需要更新指纹时，删掉该连接的信任记录让 TOFU 重新确认。
- **不做**：Telnet / 串口 / RDP / VNC、与 OpenSSH `known_hosts` 文件互通、GSSAPI 认证、配置云同步、导入 FinalShell 配置（其配置加密无法合法解出）。
- Windows 安装包暂未做代码签名，首次运行可能出现 SmartScreen 提示。

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 脚手架 · IPC 契约 · 安全基线 · 主题与布局壳 | ✅ |
| M1 | 加密凭据 · 连接管理 · SSH 会话 · 终端（批处理 + 背压） | ✅ |
| M2 | 多标签会话 · keyboard-interactive / agent 认证 · 断线重连 · 快捷命令 | ✅ |
| M3 | SFTP 浏览与传输队列（流式 + 断点续传 + 拖拽） | ✅ |
| M4 | 实时服务器监控面板（CPU / 内存 / 网络 / 磁盘） | ✅ |
| M5 | 端口转发（本地 / 远程 / 动态 SOCKS5） | ✅ |
| M6 | 设置页 · 打包发布 · 性能与视觉打磨 | ✅ |

v1.5 及以后：跳板机 ProxyJump（字段已预留；HTTP/SOCKS5 代理已支持，见上）、SFTP 传输冲突策略（同名文件目前直接覆盖）、主密码保险库、传输队列持久化、SFTP 压缩/解压、SFTP 拖出到系统、macOS / Linux 打包、自动更新、快捷键改键、Playwright e2e。

## 许可

MIT
