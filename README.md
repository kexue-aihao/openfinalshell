# openfinalshell

开源 FinalShell —— 全功能、美观 UI 的桌面 SSH 客户端：**SSH 终端 + SFTP 文件管理 + 实时服务器监控** 三合一，外加端口转发、快捷命令与加密凭据存储。

## 功能

- **连接管理**：分组树、搜索、右键菜单、复制连接、8 色标签；密码/私钥口令加密存储
- **多标签终端**：xterm.js（WebGL 渲染）、真彩色、Unicode 11 宽字符、中文/emoji 对齐、Ctrl+F 查找、选中即复制、右键粘贴、多行粘贴确认、IME 友好
- **会话健壮性**：keyboard-interactive 与 SSH Agent 认证、老设备算法兼容开关、指数退避自动重连（重连后终端缓冲保留、监控与转发自动接回）
- **经代理连接**：按连接配置 HTTP CONNECT 或 SOCKS5 代理（支持认证），域名交给代理解析；报错区分"代理问题"与"服务器问题"
- **SFTP 文件管理**：终端下方分屏、虚拟表格（万级文件不卡）、拖入上传、传输队列（暂停/继续/取消/断点续传）、权限编辑
- **实时监控**：CPU（含每核）/ 内存 / Swap / 网络 / 磁盘容量与 IO / 进程 Top，2 秒刷新
- **端口转发**：本地(-L)、远程(-R)、动态(SOCKS5)，可随连接自动启动、断线自动恢复
- **快捷命令**：分组管理、一键发送到当前或全部终端、`{{host}}`/`{{user}}`/`{{port}}` 占位符
- **深浅主题**：6 套终端配色、8 种强调色、界面缩放；中英双语

## 技术栈

Electron 43 + React 18 + TypeScript · [ssh2](https://github.com/mscdex/ssh2) · [xterm.js](https://xtermjs.org/) · Ant Design 5 · zustand · ECharts

设计取向：

- **零 native 硬依赖**：配置用 JSON + 原子写，凭据用 Electron 内置 `safeStorage`，SOCKS5 自实现 —— 不引 sqlite/argon2/keytar/socksv5，安装即可用。
- **渲染进程是纯视图**：`contextIsolation` + `sandbox` 全开，ssh2/fs 只在主进程；能力经 preload 白名单暴露，IPC 入参 zod 校验。
- **凭据引用（credentialRef）模式**：明文密码只在保存表单时单向进主进程，加密落盘后仅返回引用；**已存密码永不回传渲染进程**，日志字段自动脱敏。
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

凭据只从环境变量读，不写进代码库。会在远端 `/tmp` 建临时文件并在用例内删除；
私钥用例会往 `authorized_keys` 追加一行测试公钥并在结束时精确移除（先做备份）。

### 打包产物冒烟测试

```bash
node test/fixtures/testSshServer.mjs 2270
npm run package:dir
npm run smoke:packaged
```

它用 CDP 连上打包后的真实应用，依次验证 preload 桥注入、`safeStorage` 可用、凭据不回传明文、SSH 握手、终端中文+emoji 回显、SFTP 浏览、监控采集 —— 能抓到只在打包环境才出现的问题（asar、preload 路径、原生依赖）。

最后一步还会检查**没有可交互元素落进原生窗口按钮区**：Windows 的 `titleBarOverlay` 由 OS 绘制、
永远盖在页面之上，落进那块矩形的按钮会被压住且点不到。判定用 `navigator.windowControlsOverlay`
的实际矩形而非硬编码尺寸，覆盖主界面与连接编辑抽屉两种布局。这类问题只在真实窗口里可见 ——
单元测试和浏览器 mock 模式都抓不到。

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
- **凭据迁移**：Windows 上 `safeStorage` 走 DPAPI，密文与当前系统用户绑定 —— 重装系统或换机后 `vault.json` 无法解密。
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
