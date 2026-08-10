# Agent 工作须知（openfinalshell）

## 网络代理（必读）

本项目开发机的对外网络必须走本地代理：

```
http://127.0.0.1:7897
```

- **npm**：项目根目录 `.npmrc` 配了 `proxy` / `https-proxy`，`npm install` / `npm view` 等命令自动生效。
  **该文件已被 gitignore，不入库** —— 里面的代理只在本机存在，进了仓库会让 GitHub Actions
  和任何克隆者的 npm 都连不上 registry（`npm ci` 直接失败）。新克隆需自己建一份：

  ```bash
  printf 'proxy=http://127.0.0.1:7897\nhttps-proxy=http://127.0.0.1:7897\n' > .npmrc
  ```
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

## 国际化（i18n，必读）

**本项目面向全球多语种。任何用户可见的文案都必须走 i18n，禁止硬编码中文/英文串。** 新增功能时同步做多语种，否则不算完成。

- **语言唯一来源**：`src/shared/locales/*.json`（主/渲染共用，当前 10 种）。注册表 `src/shared/locales/registry.ts` 是"支持哪些语言"的唯一枚举点。**加一门语言 = 注册表加一条 + 加一份 `<tag>.json`（键与 en-US 全等）**，其它枚举点（设置下拉、antd locale、AppSettings.language 类型、checkI18n）都从注册表/目录派生，无需再改。
- **权威 vs 机器翻译**：`en-US`、`zh-CN` 为人工权威版；其余语言为 AI 初翻，文件头 `_meta.machineTranslated: true` 标注**待母语校对**，改这些语言的文案以人工校对为准。
- **怎么用**：
  - 渲染层：`const { t } = useTranslation()` 或 `import i18n from '@/i18n'; i18n.t(...)`（store/hook 里用后者）。
  - 主进程：`import { t } from '<相对路径>/services/i18n'`。主进程没有 react-i18next，但**报错文案也要翻译** —— 一律 `t('err.<模块>.<名>', { 变量 })`，别再 `throw new Error('中文')`。
  - 新增文案：先在 `en-US.json` + `zh-CN.json` 加键（人工），其余 8 种语言同步补齐（可先 = 英文占位或 AI 初翻并保持 `_meta` 标注）。
- **提交前必过 `npm run check:i18n`**：校验 N 种语言键**完全一致**、代码里 `t()` 用到的键都已定义、没有游离键。动态拼接的键（`t(\`region.${code}\`)`）用脚本里的 `DYNAMIC_PREFIXES` 白名单登记。
- **插值陷阱**：字符串里**不要**出现 `{{host}}` 这种字面量占位（i18next 会当插值清空它）。要展示占位符名本身时用 JSX 拼（见 `commandEditor.expandVarsHint`）。
- **刻意不入 i18n 的例外**：语言下拉里各语言的自称（endonym）、编辑器状态栏的语言名（专有名词）、终端预览里的 CJK 对齐样例；`releaseNotes.ts` 走 zh/en 双语通道、其余语言回退英文（更新说明属历史内容，不逐版翻 10 种）。
- **字节预算**：语言包**不进渲染 JS bundle**（en/zh 内联、其余运行时经 IPC `i18n:bundle` 从主进程取回），所以加语言不吃 `check:bundle` 的 950KB gzip 额度；主进程持有全部语言包（不受该预算约束）。

## 项目概览

开源 FinalShell —— Electron + React + ssh2 + xterm.js 的桌面 SSH 客户端（SSH 终端 + SFTP + 服务器监控 + 端口转发）。实施计划见 `C:\Users\Administrator\.claude\plans\ui-ssh-jaunty-bachman.md`。

- 构建：`npm run dev`（electron-vite HMR）、`npm run build`、`npm run typecheck`
- 结构：`src/shared`（IPC 契约唯一事实来源）/ `src/main`（全部 SSH/SFTP/监控/转发逻辑）/ `src/preload` / `src/renderer`
- 安全红线：contextIsolation + sandbox；凭据走 Vault(safeStorage) credentialRef 模式，明文永不回传 renderer；零 native 硬依赖（运行时依赖四个，全无 native）
