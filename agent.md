# Agent 工作须知（openfinalshell）

## 网络代理（必读）

本项目开发机的对外网络必须走本地代理：

```
http://127.0.0.1:7897
```

- **npm**：项目根目录 `.npmrc` 已配置 `proxy` / `https-proxy`，`npm install` / `npm view` 等命令自动生效，无需额外设置。
- **git**：本仓库已设置 local 配置 `http.proxy` / `https.proxy`（`git config --local -l` 可查验）。
- **其他需要联网的 shell 命令**（curl、Invoke-WebRequest、electron 二进制下载等）：执行前设置环境变量：
  - PowerShell：`$env:HTTP_PROXY='http://127.0.0.1:7897'; $env:HTTPS_PROXY='http://127.0.0.1:7897'`
  - Bash：`export HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897`
- **Electron 二进制下载**（`npm install` 时 postinstall 拉取）：额外设置 `$env:ELECTRON_GET_USE_PROXY='1'`，配合上面的 HTTP(S)_PROXY 环境变量生效。
- **npm 11 allow-scripts 坑**：本机 npm 会拦截依赖的 install 脚本（electron/esbuild/ssh2 均受影响），装完若报 "Electron uninstall"，手动执行：`cd node_modules/electron; node install.js`（带上述代理环境变量）。ssh2 的 native 构建脚本被拦无害（自动回退纯 JS）。

> 注意区分两个"代理"：上面这条是**开发机自身**联网用的（npm/git/下载）。
> 应用内还有一个面向用户的功能 —— 每条 SSH 连接可配 HTTP/SOCKS5 代理拨号
> （`src/main/ssh/proxyDial.ts`），二者互不相干，改一个不要顺手动另一个。
> 跑真机代理验收：`$env:OFS_TEST_PROXY_HOST='127.0.0.1'; $env:OFS_TEST_PROXY_PORT='7897'`
> 再加 `OFS_TEST_HOST/PORT/USER/PASSWORD`，见 `test/integration/realServerProxy.test.ts`。

## 提交信息里带双引号时用 `-F`

Windows PowerShell 5.1 向原生程序传参时，字符串内的 `"` 会破坏参数边界 ——
`git commit -m @'...含双引号...'@` 会被拆成多个 pathspec 而失败。
遇到这种消息先写入临时文件再 `git commit -F <file>`。

## 项目概览

开源 FinalShell —— Electron + React + ssh2 + xterm.js 的桌面 SSH 客户端（SSH 终端 + SFTP + 服务器监控 + 端口转发）。实施计划见 `C:\Users\Administrator\.claude\plans\ui-ssh-jaunty-bachman.md`。

- 构建：`npm run dev`（electron-vite HMR）、`npm run build`、`npm run typecheck`
- 结构：`src/shared`（IPC 契约唯一事实来源）/ `src/main`（全部 SSH/SFTP/监控/转发逻辑）/ `src/preload` / `src/renderer`
- 安全红线：contextIsolation + sandbox；凭据走 Vault(safeStorage) credentialRef 模式，明文永不回传 renderer；零 native 硬依赖
