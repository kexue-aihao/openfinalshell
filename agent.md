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

## 配置数据静态加密（at-rest，必读）

**除凭据（走 Vault）外，敏感配置也在库里加密**：主机/端口/用户名/备注、分组名、代理、私钥元数据、转发、known_hosts、命令历史。密钥体系在 `src/main/store/crypto.ts`：一把 MDK（32 字节随机）由 `safeStorage`（DPAPI，OS 账户绑定）加密后存 meta，派生子钥做 AES-256-GCM / HMAC；`safeStorage` 不可用时全部**降级为明文**、不 brick。**settings（documents 表）刻意不加密**——它不含机密，且要在 app ready 前读（决定是否禁用 GPU），那时 safeStorage 尚不可用。

- **新增敏感列必须走加密**：不透明载荷/标签列（`json`、`name` 等）写用 `encField`、读用 `decField`（未加密值原样透传）；`ORDER BY name` 这类改成读出解密后在 JS 里排序。
- **等值查找/去重/主键列**（如 `known_hosts.key`、`command_history.command`）不能用非决定论 GCM：主键存 `tokenize()`（HMAC）做等值，明文另存一个 `encField` 的显示列（`host_enc`/`cmd_enc`），读时解密还原。
- **新增敏感表/列后**：在 `src/main/store/encryptMigration.ts` 的 `encryptExistingRowsOnce` 里补上就地加密（该迁移 meta 标记守卫、整段在 `tx()` 内、崩溃可重跑），并在 `test/unit/encryptAtRest.test.ts` 加断言。
- **导出**：at-rest 密文绑本机、不可移植；导出一律从 `decField` 出来的明文出发，v1（明文/密码块）或 v2（`encryptAll` 整文件加密）。
- **换机取舍（务必知情）**：OS 绑定加密后，换机/换 Windows 账户则本机 `.db` 无法解密——迁移只能走「整文件加密导出 → 新机导入」，不能直接拷 `.db`。

## 多窗口（独立编辑器窗口）

应用现在有**两个** BrowserWindow：主窗口 + 独立编辑器窗口（单例，所有会话的「内置编辑器查看」
汇到它做多标签）。两窗口共用同一份 renderer bundle，按 URL hash `#/editor` 在 main.tsx 分流。

- **事件出口分三档**（`ipc/registry.ts`）：`emit` 只发主窗口；`emitEditor` 只发编辑器窗口；
  `broadcast` 两个都发。**broadcast 只许低频事件**（settings:changed、session:state）——
  term:data 这类字节流广播过去就是每块白克隆一次。
- **给编辑器窗口发事件要考虑就绪竞态**：窗口刚创建时 renderer 还没订阅，直接 send 必丢且不报错。
  editor:open 的解法是 main 排队 + renderer 就绪后 invoke `editor:ready` 领取（editorWindow.ts）。
  新增"主窗口 → 编辑器窗口"的推送时照这个模式来。
- **窗口壳逻辑只有一份**：主题/语言/缩放在 `hooks/useWindowShell.ts`，两个 App 根共用 ——
  别在任一侧另写一份，两个窗口一深一浅不会报错。
- **编辑器窗口的关闭要过脏裁决**：main 拦 close → `editor:closeRequest` → renderer 检查
  `hasDirty()` →（确认后）`editor:closeNow` 放行。绕过这条链路直接 destroy 会丢用户没保存的输入。
- 编辑器窗口**不接**会话/传输/监控那些 wire*：它只消费 sftp:fileView/fileSave 与上面两条广播。

## 局域网同步（LanSync，必读）

同一局域网内两台设备之间**手动收发**应用数据（`src/main/lansync/`）。刻意**不是**自动双向同步——
现有 `applyImport` 的合并是按 id upsert、无时间戳裁决、无删除墓碑，自动双向会让"A 删掉的连接被 B 推回来复活"成为日常。
心智是"发一份副本"，接收端确认后走既有的 skip/overwrite/duplicate 三策略合并。

- **载荷就是标准 v2 加密信封**：发送侧 `buildExportEnvelope({ encryptAll: true, passphrase: 通道密钥 })`，
  接收侧 `inspectImportFromText(text, { passphrase })` → 原样 `applyImport`。线上除信封头元数据（版本/时间/设备名）外**无明文**。
  **绝不改成明文发送**（`encryptAll: true` 有护栏钉着）；接收端复用 `applyImport` 意味着自动继承 `sanitizeSettings` +
  `stripMainOnlyPaths`（导入是第二个不可信入口，历史上被植入过 exe 路径）——新增导入旁路时务必保持这条。
- **配对码只做认证、不做密钥**：`pairKey = scrypt(6位码, HKDF(X25519共享秘密, salt, transcript))`（`pairing.ts`）。
  scrypt 的盐折进了 ECDH 秘密，被动嗅探者没有暴力起点；transcript 绑双方公钥+salt+sessionId 挡 MITM/重放。
  **码证明必须过 scrypt 不是裸 HMAC**（否则离线爆破从数十核时塌成瞬间，护栏钉着）；比较用 `timingSafeEqual`。
- **未认证网络路径上的重活必须异步 + 幂等**：`derivePairKey` 用 `scrypt`（异步、走线程池）而非
  `scryptSync`——它跑在收到未认证 `hello` 帧的路径上（早于任何码校验），同步版会让局域网对端用
  重复 hello 把主进程事件循环连续占满（界面 + 所有 SSH 会话冻结）。配套每连接"只处理首个 hello"
  的幂等守卫（`senderPub` 同步置位挡住后续），未认证对端至多触发一次线程池 scrypt。握手期帧用
  `HANDSHAKE_MAX_FRAME_BYTES`（64KiB）小上限，confirm 成功后才升到 64MiB 收 payload。
  教训：**任何在鉴权之前响应网络输入的地方，别放同步 CPU 重活，也别让单连接无上限重复触发它**。
- **烧码规则**：错码或 confirm 后失败 → `rotateCode()` 换新码（每会话=一次在线猜测，10⁻⁶）；
  **confirm 之前的异常断开不烧码**（端口扫描器/半开连接不该逼用户重读码）。单飞行握手：第二条连入回 `error{busy}`。
- **发现只用 node:dgram**（组播 239.255.77.88:52133 + 广播兜底），传输只用 node:net，配对只用 node:crypto——
  零 native 红线内。发现是尽力而为，**手输 IP:端口 是一等公民兜底**（组播常被企业网隔离、防火墙可能拦监听）。
- **状态推送走 `emit` 到主窗口**（面板在主窗口，低频，不用 broadcast）；store 照 useUpdateStore 的"订阅缓存不乐观更新"。
- **生命周期**：`before-quit` 里 `lanSyncManager.stopAll()` 必须**先于** `closeDatabase()`；接收态 10 分钟空转自停（不留开放端口）。
  发送 Promise 每条结算路径都要释放 `sendSession`（error 路径同步释放，别只等 'close' 事件——调用方常在 await 抛出后立刻重试）。
- 测试：纯函数（protocol/pairing）单测 + 真 TCP 端到端（`test/integration/lansync.test.ts`，同进程收发）+ 安全护栏
  （`test/renderer/lanSyncWiring.test.ts`，钉 encryptAll/scrypt/confirm 顺序）。

## 渲染层组件测试（jsdom）

测试分四层：`test/unit` + `test/integration`（node 环境）、`test/renderer`（**读源码**的 grep 护栏）、
`test/component`（**jsdom 里真渲染组件**）。前三层测不到运行时时序 —— cd 跟随连着两个线上 bug
（0.15.2 的过期回包、0.15.4 的回显赛跑）都是"编译过、护栏绿、真跑起来才错"，组件层就是为这类行为立的。

- **何时写组件测试**：行为依赖**异步交错**（并发回包谁先回、失败之后再成功、事件到达早于/晚于状态）时。
  纯逻辑仍然下放纯函数单测；"代码长什么样"的约束仍然归 grep 护栏。
- **底座**：文件放 `test/component/*.test.tsx`，文件头一行 `// @vitest-environment jsdom`（默认环境仍是 node）。
  `test/component/setup.ts` 经 setupFiles 在测试文件求值前安装 `window.ofs`（`fakeOfs`）与 DOM 垫片 ——
  时机是硬要求：`@/ipc/api` 在模块求值时就把 `window.ofs` 捕获成常量，晚一步只能拿到 DEV mock。
- **fakeOfs 是控制面**：每条 invoke 的回包时机测试自己握（`deferred()`），并发交错就是这么摆出来的；
  未注册的 channel 一律 reject，逼测试显式声明依赖。
- **真 xterm 不 `open()` 也可用**：解析器/缓冲/onData/onLineFeed 全是活的（jsdom 缺的只是渲染器度量），
  终端类测试用 `vi.mock` 替换 `createTerminal`、给实例打 `open`/`focus` 两个 no-op 补丁即可，见
  `terminalCaptureTiming.test.tsx`。
- **回归测试必须自证有牙**：新写的用例先 `git checkout <坏版本> -- <文件>` 换回旧实现跑一遍、确认变红再收
  （fakeBuffer 那批"首跑全绿"的测试曾经全是摆设）。tsconfig 归属：`test/component` 归 web（要 DOM/JSX），
  已从 node 侧 exclude。

## 项目概览

开源 FinalShell —— Electron + React + ssh2 + xterm.js 的桌面 SSH 客户端（SSH 终端 + SFTP + 服务器监控 + 端口转发）。实施计划见 `C:\Users\Administrator\.claude\plans\ui-ssh-jaunty-bachman.md`。

- 构建：`npm run dev`（electron-vite HMR）、`npm run build`、`npm run typecheck`
- 结构：`src/shared`（IPC 契约唯一事实来源）/ `src/main`（全部 SSH/SFTP/监控/转发逻辑）/ `src/preload` / `src/renderer`
- 安全红线：contextIsolation + sandbox；凭据走 Vault(safeStorage) credentialRef 模式，明文永不回传 renderer；零 native 硬依赖（运行时依赖四个，全无 native）
