# openfinalshell

开源 FinalShell —— 全功能、美观 UI 的桌面 SSH 客户端：**SSH 终端 + SFTP 文件管理 + 实时服务器监控** 三合一，外加端口转发、快捷命令与加密凭据存储。

> 状态：开发中。已完成 M0（脚手架 / IPC 契约 / 安全基线 / 主题布局壳）与 M1（加密凭据 · 连接管理 · SSH 会话 · 多标签终端）。

## 技术栈

Electron + React 18 + TypeScript · [ssh2](https://github.com/mscdex/ssh2) · [xterm.js](https://xtermjs.org/) · Ant Design 5 · zustand · ECharts

设计取向：

- **零 native 硬依赖**：配置用 JSON + 原子写，凭据用 Electron 内置 `safeStorage`，KDF 用 Node 内置 `crypto` —— 不引 sqlite/argon2/keytar，安装即可用。
- **渲染进程是纯视图**：`contextIsolation` + `sandbox` 全开，ssh2/fs 只在主进程；能力经 preload 白名单暴露。
- **凭据引用（credentialRef）模式**：明文密码只在保存表单时单向进主进程，加密落盘后仅返回引用；**已存密码永不回传渲染进程**。

## 开发

```bash
npm install
npm run dev
```

其他命令：

| 命令 | 说明 |
|---|---|
| `npm run build` | 三层生产构建 |
| `npm run typecheck` | 主进程 + 渲染层类型检查 |
| `npm test` | 单元测试 + 集成测试（会自动起本地测试 SSH 服务器） |
| `npm run package` | 打 Windows 安装包（NSIS + portable） |

### 本地测试 SSH 服务器

没有可用的 Linux 主机时，用内置 fixture 起一个真实 SSH 服务：

```bash
node test/fixtures/testSshServer.mjs 2222
```

账号 `test` / 密码 `test123`（另有 `kbi` / `test123` 用于验证 keyboard-interactive 流程）。终端内支持 `echo`、`size`、`flood <MB>`（压测背压）、`exit`。

### 浏览器调试模式

`npm run dev` 后直接用浏览器打开 <http://localhost:5173>，渲染层会在缺少 preload 时启用 mock IPC，提供一个本地模拟终端 —— 便于纯 UI 迭代（不连真实服务器）。

## 已知限制

- **仅支持 UTF-8 的远程文件名**：ssh2 对文件名做有损 UTF-8 解码，非 UTF-8 编码（如 GB18030）的文件名无法可靠还原，此类条目在文件列表中标黄且禁止操作。终端流的编码不受此限制（GBK 等经 iconv-lite 双向转码）。
- **私钥格式**：支持 OpenSSH（新旧格式）、PEM、PuTTY PPK v2。PPK v3 请先用 `puttygen` 另存为 v2。
- **凭据迁移**：Windows 上 `safeStorage` 走 DPAPI，密文与当前系统用户绑定 —— 重装系统或换机后 `vault.json` 无法解密，加密导出是唯一迁移路径。
- **不做**：Telnet / 串口 / RDP / VNC、与 OpenSSH `known_hosts` 文件互通、GSSAPI 认证、配置云同步、导入 FinalShell 配置（其配置加密无法合法解出）。
- Windows 安装包暂未做代码签名，首次运行可能出现 SmartScreen 提示。

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 脚手架 · IPC 契约 · 安全基线 · 主题与布局壳 | ✅ |
| M1 | 加密凭据 · 连接管理 · SSH 会话 · 终端（批处理 + 背压） | ✅ |
| M2 | 多标签会话 · keyboard-interactive / agent 认证 · 断线重连 · 快捷命令 | 🚧 |
| M3 | SFTP 浏览与传输队列（流式 + 断点续传 + 拖拽） | ⏳ |
| M4 | 实时服务器监控面板（CPU / 内存 / 网络 / 磁盘） | ⏳ |
| M5 | 端口转发（本地 / 远程 / 动态 SOCKS5） | ⏳ |
| M6 | 设置页 · 打包发布 · 性能与视觉打磨 | ⏳ |

v1.5 及以后：跳板机 ProxyJump、主密码保险库、传输队列持久化、SFTP 压缩解压、macOS / Linux 打包、自动更新。

## 许可

MIT
