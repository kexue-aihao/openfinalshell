# 原生 RDP 架构与 UX 冻结

> RDP-002；A2 ArchitectUX；版本 1.0；2026-09-05
>
> 本文是 RDP-003 至 RDP-010 的实施契约。它只冻结已经选定的 profile、消息、状态、
> 安全和降级语义，不修改源代码。现有 `project-docs/rdp-architecture.md` 是较早的
> ARCH-01 协议说明；本文作为本轮 RDP-002 的派发基线，若两者重复，以本文的任务映射
> 和实际代码边界为准。

## 1. 决策摘要

- 桌面端 RDP 默认创建应用内 `rdp` tab，由每个 session 独占一个 FreeRDP Worker；正常
  路径不启动 `mstsc`，也不建立本地 RDP TCP 代理。
- `main` 是会话、凭据、Worker 生命周期和错误码的事实来源；renderer 不能读取 Worker
  路径、PID、FreeRDP 原始错误或任何密码。
- Worker stdin/stdout 使用版本 1 的 `OFSR` 长度帧协议。控制消息是 UTF-8 JSON，画面是
  BGRA8 dirty-rectangle payload。renderer 画面使用专用 transferable `MessagePort`。
- profile 中只保存 Vault 引用 `passwordRef`，不保存 RDP 密码明文。没有可用引用时通过
  现有 `PromptBroker` 取得一次性密码；是否记住由用户显式选择。
- `certificatePolicy` 只有 `prompt` 和 `strict` 两种值。`prompt` 是一次性允许，
  `strict` 是无 UI 的直接拒绝；v1 不提供长期证书信任按钮或信任库。
- Worker 缺失、协议不匹配或连接失败不会自动打开外部客户端。用户可在失败 tab 中显式
  选择“使用系统远程桌面”，该动作才调用既有 `conn:launchRdp`/`shell.openPath`。
- 当前已确定的协议选择不因 RDP-003 至 RDP-010 改变。未决事项只能影响证据、平台是否
  启用或性能结论，不能重新定义字段、消息或状态语义。

## 2. Profile 模型与旧配置兼容

### 2.1 持久化字段

RDP 复用 `ConnectionProfile` 的通用字段 `id`、`name`、`protocol`、`host`、`port`、
`username`、`groupId`、`color`、`flag`、`note` 和时间字段。SSH 专用的 `auth`、
`terminal`、`options`、`proxy*` 字段仍存在于共享模型，但 RDP Worker 只使用下列字段：

| 字段 | 类型 | 缺省/语义 | 是否进入 Worker |
| --- | --- | --- | --- |
| `protocol` | `'rdp'` | 缺省表示旧 SSH profile，不得猜测为 RDP | 间接决定是否建立 RDP |
| `host` | 非空字符串 | main `trim()` 后使用 | `START.host` |
| `port` | `1..65535` | RDP UI 新建默认 `3389` | `START.port` |
| `username` | 字符串，可为空 | 空值允许 Worker/服务端继续认证流程 | `START.username` |
| `rdp.domain` | 可选字符串 | 缺失解释为 `''` | `START.domain` |
| `rdp.passwordRef` | 可选 `SecretRef` | 缺失时连接前询问一次性密码 | 绝不进入 Worker 配置，密码仅单向发送 |
| `rdp.clipboard` | 可选布尔值 | 缺失解释为 `true` | `START.features.clipboard` |
| `rdp.certificatePolicy` | `'prompt' \| 'strict'` | 缺失解释为 `'prompt'` | `START.features.certificatePolicy` |

实际类型定义位于 `src/shared/types.ts` 的 `RdpProfileOptions`、`RdpProfileDraft` 和
`ConnectionProfile`。保存逻辑位于 `src/main/store/connections.ts`：RDP 密码先写 Vault，
profile 只写引用；从 RDP 切回 SSH 时删除无引用的 RDP Vault secret。

### 2.2 兼容规则

1. `protocol` 缺失的旧 profile 继续解释为 SSH；不能因为存在 `host` 或 `port` 推断为 RDP。
2. `protocol: 'rdp'` 且没有 `rdp` block 的旧 profile 合法，按 `domain=''`、`clipboard=true`、
   `certificatePolicy='prompt'`、无密码引用处理。
3. RDP profile 的 `username` 可以为空；SSH profile 仍要求非空用户名。该差异已在
   `src/main/ipc/conn.ipc.ts` 的 `profileDraftSchema` 和
   `test/unit/rdpProfileContract.test.ts` 固定。
4. 编辑 profile 时，空密码或未传 `password` 表示保持现有引用；只有 `clearPassword: true`
   才删除 Vault secret。切换为 SSH 会清理 RDP 引用。RDP-003 必须让表单能表达这两个动作。
5. RDP 编辑页不得把未出现在表单中的值硬编码覆盖成 `clipboard=true` 或
   `certificatePolicy='prompt'`。当前 `ProfileEditDrawer.tsx` 的硬编码是 RDP-003 的已知
   修复点，不是新的数据协议。

## 3. 密码生命周期

密码的唯一合法路径如下：

```text
ProfileEditDrawer（只写 draft.password）
    -> conn:save / main profile store
    -> Vault（只留 passwordRef）
    -> RdpSessionManager 局部变量
    -> OFSR CREDENTIAL 一次
    -> FreeRDP settings / NLA
```

- renderer 只可提交 `RdpProfileDraft.password`，不可读取 `passwordRef` 对应的明文。
- `RdpSessionManager.sendPasswordIfAvailable()` 先从 Vault 读取引用；读取不到、引用缺失或
  Vault 不可用时，调用 `promptBroker.request(sessionId, 'rdp-password', payload, 120000)`。
- 密码 prompt payload 只能包含 `username` 和 `host`。renderer 的普通 session store、日志、
  URL、argv、环境变量、`.rdp` 文件和错误 message 均不得包含密码。
- 用户选择 `remember=true` 时，main 调用 `rememberRdpPassword()` 写入 Vault；不选择则只
  在当前连接使用。无论是否记住，都必须发送同一条一次性
  `{op:'credential',kind:'password',value}` Worker 消息。
- 写入 Worker 后立即清空 main 局部字符串引用；Worker 消费后清零其临时 command 文本。
- 密码 prompt 120 秒超时、取消、关闭或旧 Worker 失效，均不得重放密码；连接以 `CANCELED`
  或对应关闭/失败状态结束。

证据入口：`src/main/rdp/RdpSessionManager.ts`、`src/main/store/connections.ts`、
`src/main/ssh/PromptBroker.ts`、`src/renderer/src/features/prompts/PromptHost.tsx`，以及
`test/unit/rdpSessionManager.test.ts` 中的密码 prompt/remember 测试。

## 4. Domain、clipboard 与证书策略

### 4.1 Domain

`rdp.domain` 是可选字符串，缺失固定下发空字符串。它只影响 RDP 登录域，不拼接到
`username`，不写入密码字段，也不改变 profile 的 SSH `auth` 语义。`START` 必须始终带
`domain` 字段，即使值为 `''`。RDP-003 增加可编辑 Domain 控件；RDP-010 用真实账号验证。

### 4.2 Clipboard

- `rdp.clipboard` 缺失兼容为 `true`；显式 `false` 表示不启用 `cliprdr`。
- `START.features.clipboard` 是必填布尔值。profile 要求剪贴板而 Worker HELLO 没有
  `clipboard` capability 时，main 以 `UNSUPPORTED` 失败，不静默降级。
- renderer 的文本粘贴调用 `rdp:clipboardSet`，复制调用 `rdp:clipboardGet`；main 只接受
  `text/plain`，文本最大 1,000,000 字符。Worker 返回 `CLIPBOARD_DATA` 后，main 发布
  `rdp:clipboard`，renderer 写入本机 clipboard。
- clipboard 只在 `ready` 状态开放；禁用、未就绪、关闭或旧 session 的请求均不产生新的
  远端数据。
- v1 只支持文本，不承诺 HTML、图片、文件或双向系统剪贴板权限提示。

实际入口：`src/shared/types.ts`、`src/shared/ipc.ts`、`src/main/ipc/rdp.ipc.ts`、
`src/main/rdp/RdpSessionManager.ts`、`native/rdp-worker/main.cpp`、
`native/rdp-worker/freerdp_adapter.cpp` 和 `src/renderer/src/features/sessions/RdpPane.tsx`。

### 4.3 Certificate `prompt` / `strict`

| 策略 | Worker 行为 | main 行为 | 用户体验 |
| --- | --- | --- | --- |
| `prompt` | 未知或变更证书发送 `PROMPT`，携带 host、port、subject、issuer、SHA-256 fingerprint、`changed` | 以相同 request id 调 `PromptBroker`，60 秒内把 `ok` 转为 `CREDENTIAL` certificate reply | 显示一次性允许/取消；不提供永久信任 |
| `strict` | FreeRDP 直接拒绝证书 | 即使 Worker 错误发送 `PROMPT`，main 也直接回 `accept:false`，绝不调 PromptHost | 无确认弹窗，失败码 `CERTIFICATE_REJECTED` |

证书 reply 的唯一格式是 `{op:'certificate',requestId,accept}`，帧头 request id 与 JSON
`requestId` 必须相同且非零。重复、迟到、未知 request id 丢弃；关闭 session 会取消全部
pending prompts。证书信息只用于当前提示和脱敏诊断，不写长期信任库。

实际 UI 已在 `src/renderer/src/features/prompts/PromptHost.tsx` 支持
`rdp-certificate`；main 处理在 `RdpSessionManager.handleCertificatePrompt()`。契约证据
位于 `test/unit/rdpSessionManager.test.ts` 的 strict 拒绝和重复 prompt 测试。

## 5. Worker / main / preload / renderer 消息契约

### 5.1 Worker framed protocol

stdin/stdout 每帧固定 16 字节 little-endian header：`magic='OFSR'`、`version=1`、
`type`、`flags=0`、`payloadLength<=64 MiB`、`requestId`。main 和 Worker 都必须先校验
magic、version、flags、长度和 EOF，再分配 payload。控制 payload 必须是 UTF-8 JSON object
并含 `op`；只有 `FRAME` 是二进制。

| type | 名称 | 方向 | 固定内容 |
| ---: | --- | --- | --- |
| `0x01` | `HELLO` | Worker -> main | `hello, protocol, workerVersion, capabilities[]`；必须含 `framebuffer,input,resize` |
| `0x02` | `HELLO_ACK` | main -> Worker | `helloAck, protocol:1, sessionId, maxPayload:67108864` |
| `0x10` | `START` | main -> Worker | host、port、username、domain、`gateway:null`、display、features |
| `0x11` | `CREDENTIAL` | main -> Worker | password 或 certificate reply；密码只发一次 |
| `0x12` | `CLOSE` | main -> Worker | `reason: user \| reconnect \| shutdown` |
| `0x13` | `RESIZE` | main -> Worker | `width,height,dpi` |
| `0x14` | `KEY` | main -> Worker | `scanCode,pressed,extended?`, 可选 Unicode scalar |
| `0x15` | `POINTER` | main -> Worker | `x,y,buttons,wheelX?,wheelY?` |
| `0x16` | `CLIPBOARD_SET` | main -> Worker | `mime:'text/plain',text` |
| `0x17` | `CLIPBOARD_GET` | main -> Worker | `requestId` |
| `0x20` | `STATE` | Worker -> main | `state` 或内部 `ack` |
| `0x21` | `PROMPT` | Worker -> main | 当前仅 certificate prompt，含 request id 与证书 payload |
| `0x22` | `CLIPBOARD_DATA` | Worker -> main | `mime:'text/plain',text` |
| `0x30` | `FRAME` | Worker -> main | BGRA8 dirty rectangles |
| `0x7f` | `ERROR` | Worker -> main | 稳定 `code` 和脱敏 `message` |

`HELLO` 成功后 main 才发送 `HELLO_ACK` 和 `START`。打包生产路径要求
`workerVersion:'freerdp'`、capability `freerdp` 且不得含 `mock`；剪贴板开启时还必须有
`clipboard`。`START.gateway` v1 固定为 `null`，RD Gateway 不通过忽略字段的方式伪装支持。

`FRAME` payload 头为 `canvasWidth,canvasHeight,sequence,rectCount,reserved`，每个矩形为
`x,y,width,height,stride,byteLength,pixels`。矩形必须在画布内、stride 至少 `width*4`，
字节长度精确等于 `stride*height`，总 payload 不超过 64 MiB。main 丢弃 sequence 倒退帧。
当前 FreeRDP adapter 在 `endPaint()` 仍可能生成覆盖全屏的单矩形；RDP-005 负责在不改变
上述格式的前提下改善 dirty-region 和复制成本。

实现入口：`src/main/rdp/RdpSessionManager.ts`、`native/rdp-worker/main.cpp`、
`native/rdp-worker/freerdp_adapter.cpp`、`native/rdp-worker/freerdp_adapter.h`。

### 5.2 main IPC 与 preload

`src/shared/ipc.ts` 是 renderer -> main 和 main -> renderer 的类型事实来源。RDP invoke
白名单固定为：

```text
rdp:open({profileId,display}) -> {sessionId}
rdp:close(sessionId) -> void
rdp:reconnect(sessionId) -> void
rdp:input({sessionId,input}) -> void
rdp:resize({sessionId,display}) -> void
rdp:clipboardSet({sessionId,text}) -> void
rdp:clipboardGet(sessionId) -> void
rdp:systemFallback(sessionId) -> void
```

`src/main/ipc/rdp.ipc.ts` 对每个 invoke 和 `rdp:port` attach payload 做 zod 校验，并由
registry 执行 trusted sender 校验。`src/preload/index.ts` 只暴露 `ofs` typed API；不能
把 `ipcRenderer`、Worker path 或 Node API 暴露给 renderer。

main -> renderer 事件固定为：

- `rdp:state`: `{sessionId,state,errorCode?,error?}`；error message 是本地化的类别和建议，
  不含密码、完整命令行或敏感连接选项。
- `rdp:clipboard`: `{sessionId,text}`，只在当前 session 和文本限制内发布。
- `rdp:frame`: 共享类型中保留的旧事件形状；生产路径不依赖它，当前 manager 将帧交给
  专用 MessagePort。renderer 仍保留兼容监听，以支持旧 main/mock 测试，不得同时消费同一帧。

专用 port 的 main -> renderer 消息唯一为：
`{kind:'frame',sequence,canvasWidth,canvasHeight,buffer:ArrayBuffer}`；renderer -> main
唯一为 `{kind:'frameAck',sequence}`。preload 通过 `isRdpPortFrameMessage()` 精确过滤字段、
尺寸、像素上限和真实 ArrayBuffer，并只允许 ACK 当前回调对应的 sequence。

每个 session 最多两帧未确认；第三帧触发 latest-wins replacement 和 stdout pause，ACK 或
500ms timeout 后恢复。port replacement 会关闭旧 port；旧 dispose 不得关闭新 port。
对应入口为 `src/preload/index.ts`、`src/renderer/src/features/sessions/RdpPane.tsx`、
`src/renderer/src/features/sessions/RdpPane.module.css` 和
`test/unit/preloadContract.test.ts`。

### 5.3 状态与用户可见结果

公开 RDP 状态固定为：

```text
starting -> handshaking -> connecting -> authenticating/verifying -> ready
ready -> closing -> closed
ready/connecting -> failed -> closing -> closed
failed/closed -> reconnecting -> starting
```

`ready` 的必要条件是 Worker 已报告 `ready` 且 main 已收到第一帧有效画面；在此前输入、
clipboard、resize 都返回 `SESSION_NOT_READY`。稳定错误码固定为：

```text
WORKER_MISSING, WORKER_START_FAILED, PROTOCOL_MISMATCH, PROTOCOL_ERROR,
AUTH_FAILED, CERTIFICATE_REJECTED, UNSUPPORTED, NETWORK_ERROR,
WORKER_CRASHED, SESSION_NOT_READY, CANCELED
```

renderer 的 `useSessionStore` 负责把 RDP 状态映射到 tab，并缓存尚未被 tab 认领的状态/帧。
`RdpPane` 显示 connecting、closed/error、重试和系统远程桌面按钮；它只允许 active + ready
tab 发送键鼠和 clipboard。失败不会自动 fallback，用户点击按钮才触发 fallback。

## 6. 关闭、重连与旧 Worker 隔离

### 用户关闭

main 先置 `closing`，发送 `CLOSE(user)`，取消 prompt、resize timer、frame ledger 并关闭
port；收到 Worker `closed` 或进程 exit 后发布 `closed`。最多等待 2 秒，超时 kill 后仍发布
`closed`。用户关闭不是连接错误，不附带失败码。应用退出由
`src/main/index.ts` 的 `before-quit` 等待 `rdpSessionManager.closeAll()`；更新安装由
`src/main/services/updater.ts` 同样先关闭 RDP workers。

### 重连

显式重连复用原 `sessionId` 和 tab，不重新创建 profile。顺序固定为：

1. 旧 session 发送 `CLOSE(reconnect)` 并等待关闭或 2 秒截止。
2. 旧 Worker、旧 port、旧 pending frame/prompt 全部失效并清理。
3. 使用冻结的 profile 与最后一次钳制后的 display 创建新 Worker。
4. renderer 增加 `rdpPortEpoch`，重新绑定新 port；新连接必须重新满足 ready + first frame。

`RdpSessionManager.isCurrent(session)`、session object identity、`session.port === port` 和
renderer 的 `rdpPortEpoch` 是隔离机制。旧 Worker 的 stdout、exit、state、frame、prompt、
旧 port ACK/close 均直接丢弃，不能污染同一个 `sessionId` 的新代连接。

### Worker 异常

意外 exit、stdout EOF 或管道 error 映射为 `WORKER_CRASHED`，tab 保留且显示重试和系统
远程桌面按钮。Worker 不存在或 HELLO 不合格分别映射为 `WORKER_MISSING` 或
`PROTOCOL_MISMATCH`。这些路径都不自动创建外部窗口。

## 7. 平台能力、降级与限制

| 目标 | 本轮冻结结论 | 用户可见行为 |
| --- | --- | --- |
| Windows x64 | 原生 FreeRDP Worker 目标；打包要求 `require-freerdp` | 默认嵌入式 tab；失败后可显式系统远程桌面 |
| macOS | 当前不启用原生 Worker，直到构建、依赖、签名、公证、真实服务器证据齐全 | 不宣称嵌入式 RDP；提供系统 fallback 能力时明确提示 |
| Linux | 当前不启用原生 Worker，直到目标发行版运行时依赖和真实验收齐全 | 同上，不打包 mock 冒充原生支持 |
| Windows ARM64 | 当前不启用原生 Worker，直到架构构建和验收齐全 | 同上 |
| Android | 只有 shared profile/schema 兼容性；本轮不实现 RDP UI/engine | 不得以 profile 可解析宣传 Android 原生 RDP |

系统 fallback 由 `src/main/services/rdpLaunch.ts` 生成不含密码的 `.rdp` 文件并调用
`shell.openPath`。fallback 错误以本地化 toast 呈现；它不改变嵌入式 tab 的失败状态，也不
绕过 profile 校验。用户可见错误映射由 `RdpSessionManager.errorDescription()` 和
`src/shared/locales/*` 提供，至少覆盖上述所有稳定错误码以及 profile invalid、session not
found、system fallback launch failed。

v1 明确不支持音频、打印机、磁盘/驱动器、摄像头、智能卡、USB/串口/并口设备重定向、
多显示器、RD Gateway 和长期证书信任库。Worker 收到这些未来字段必须返回 `UNSUPPORTED`
或协议错误，不能静默接受。

## 8. RDP-003 至 RDP-010 实现映射

| 任务 | 责任边界 | 冻结后的实现/验收入口 |
| --- | --- | --- |
| RDP-003 配置与持久化 | Renderer 表单、字段保留、clear password、locale；不得改 Worker 协议 | `ProfileEditDrawer.tsx`、`src/main/store/connections.ts`、`src/shared/types.ts`；`test/unit/rdpProfileContract.test.ts`、`test/renderer/rdpWiring.test.ts`、`test/renderer/sessionStore.test.ts`、`npm run check:i18n`、`npm run typecheck` |
| RDP-004 Unicode/IME | renderer `KeyboardEvent` -> typed input -> native FreeRDP Unicode API；扫描码/扩展键不回归 | `RdpPane.tsx`、`rdp.ipc.ts`、`freerdp_adapter.cpp`；`test/renderer/rdpInput.test.tsx`、`test/unit/rdpContract.test.ts`、Worker CTest、授权服务器 smoke |
| RDP-005 帧传输与校验 | dirty-region、尺寸/stride/payload 一致校验、背压和旧代隔离；不改变 OFSR frame shape | `RdpSessionManager.ts`、`freerdp_adapter.cpp`、`RdpPane.tsx`；`test/renderer/rdpFrameComposition.test.ts`、`test/unit/rdpSessionManager.test.ts`、`test/unit/rdpShutdownContract.test.ts`、CTest |
| RDP-006 Worker/平台矩阵 | 构建、staging、Worker 自动发现、平台 unsupported gate；生产不打包 mock | `scripts/buildRdpWorker.mjs`、`scripts/checkRdpWorkerPackage.mjs`、`electron-builder.yml`、`.github/workflows/*`；`test/unit/rdpNativeBuildConfig.test.ts`、`test/unit/rdpWorkerPackageGate.test.ts`、`test/renderer/rdpPackaging.test.ts` |
| RDP-007 合规与安全 | 最终 DLL 版本来源、license、NOTICE、SBOM、CVE 和发布门禁 | Worker staging、`rdp-worker-runtime.json`、`THIRD-PARTY-NOTICES.rdp-worker.txt`；依赖最终产物扫描，不以单个 LICENSE 存在放行 |
| RDP-008 签名与信任 | App/Worker 签名、时间戳、macOS nested library/notarization；签名失败阻断 release | `.github/workflows/build-windows.yml` 及对应平台 workflow；`Get-AuthenticodeSignature`/`signtool` 或 `codesign`/`spctl`/`stapler` |
| RDP-009 性能与长稳 | 1920x1080、30 FPS、60 秒、resize/input/clipboard/断线重连指标；阈值由 A8+A0 预先确认 | Worker smoke、Electron/GPU harness、性能原始日志；指标含首帧、帧率、丢帧、CPU、内存、IPC、输入 p95、恢复时间 |
| RDP-010 真实服务器验收 | 最终打包 FreeRDP Worker 的认证、证书、输入、resize、clipboard、断开、重连、关闭和旧代隔离 | `scripts/smokeRdpWorker.mjs`、`npm run smoke:rdp-worker -- build/rdp-worker/ofs-rdp-worker.exe`、`test/unit/rdpSessionManager.test.ts`、`test/unit/rdpShutdownContract.test.ts`；凭据只用环境变量注入 |

## 9. 契约测试入口与门禁

RDP-002 文档级 QA 至少执行：

```text
npm test -- --run test/unit/rdpContract.test.ts test/unit/rdpProfileContract.test.ts test/unit/rdpSessionManager.test.ts test/unit/preloadContract.test.ts
npm run typecheck
```

后续集成任务使用各自映射中的测试入口，并保持以下不变量：旧 SSH、SFTP、监控和
`conn:launchRdp` 测试不回归；生产 Worker HELLO 不是 mock；所有协议错误可确定地失败；
密码不出现在 argv、日志、普通 renderer state、`.rdp` 或仓库。

现有证据与缺口记录见 `project-docs/rdp-native-worker-audit.md`、
`project-docs/rdp-native-orchestration-plan.md` 和 `project-tasks/rdp-native-tasklist.md`。

## 10. 未决事项（不阻塞协议派发）

以下事项尚未有最终证据或运营决定，但不允许重新打开本文件已经冻结的字段、消息、状态
和安全语义：

1. 需要授权的真实 Windows RDP 测试服务器、账号、Domain 和可控证书场景，以完成
   RDP-004、RDP-009、RDP-010 的真实验收；缺少时记录 `BLOCKED_EXTERNAL_ENV`。
2. A8 与 A0 尚需在真实目标设备上签署 CPU、内存、帧率、首帧和输入 p95 阈值；阈值未签署
   前只能报告测量值，不能报告性能 PASS。
3. macOS、Linux、Windows ARM64 是否在后续 release 启用，取决于各平台构建、运行时依赖、
   签名和真实服务器证据；在证据齐全前固定为 unsupported，不影响 Windows x64 任务执行。
4. 最终 FreeRDP/WinPR/OpenSSL/编解码依赖版本、SBOM/CVE 数据源、签名证书和公证凭据
   需要由发布与合规负责人提供；这只影响 RDP-007/RDP-008 的门禁结果。
5. RDP-003 的具体视觉控件排序、文案和各 locale 翻译可以按现有 Ant Design 规范调整，
   但必须保留本文规定的字段可编辑、保留和清除语义。

没有未决的 wire-format、字段默认值、密码处理、证书应答、状态机或降级协议选择；因此
RDP-003 至 RDP-006 可以在本冻结完成后派发，RDP-007 至 RDP-010 按任务依赖推进。

## 11. A3 契约对齐决策

本节将 A3 审查中的实现风险转为强制门禁，避免兼容路径成为第二套生产事实来源。

1. **帧传输唯一来源**：生产 main 只通过 `rdp:port` 的专用 `MessagePort` 发送帧。
   `rdp:frame` 仅保留给旧版 main/mock 的测试兼容，不得由生产
   `RdpSessionManager` 发布，也不得被 `latestRdpFrame` 当作生产补帧来源。RDP-005 必须
   增加单路径断言。
2. **帧格式唯一化**：当前版本冻结为 `rdp-frame-v1`。外层 MessagePort 消息固定包含
   `kind='frame'`、`sequence`、`canvasWidth`、`canvasHeight` 和 `buffer` 五个字段；
   `buffer` 固定是按顺序拼接的 dirty-rectangle 记录，不包含 OFSR 的 16 字节外层帧头。
   每条记录固定为 `x:int32`、`y:int32`、`width:uint32`、`height:uint32`、
   `stride:uint32`、`byteLength:uint32`、BGRA8 像素；总长度必须精确匹配，禁止 Renderer
   再猜测完整整屏、带外层帧头或其他隐式变体。OFSR Worker -> main 仍保留 16 字节帧头，
   由 main 校验后剥离。
3. **稳定错误码**：`rdp:state.errorCode` 是公开的机器可判定字段；Renderer store、tab
   view-model 和 UI 操作决策必须保留它，`error` 仅用于展示。自动重试、系统 fallback
   和测试不得解析本地化文本来判断错误类别。
4. **系统 fallback 前置条件**：`rdp:systemFallback` 只允许 `failed` 或 `closed` 的
   session；活动 Worker、`starting`、`connecting`、`ready`、`closing` 或未知 session
   必须拒绝且不启动系统客户端。若未来产品要求活动会话 fallback，必须先使用明确的
   `fallback` close reason 完成可观察关闭，再启动外部客户端，并另行更新本契约。
5. **状态和代际记录**：逻辑 `sessionId`、Worker generation 和 `rdpPortEpoch` 继续
   分离。generation 至少进入 main 诊断和 QA 证据；旧 Worker、旧 port、重复/迟到 ACK
   和旧 sequence 必须被丢弃，不能改变新代会话的背压或状态。
6. **Clipboard 响应边界**：v1 每个 session 最多允许一个 outstanding `clipboardGet`；
   并发请求必须合并或返回稳定错误，远端主动更新与请求响应的语义必须在测试中区分。
   如果 Worker 能提供 request id，则 main 和 Renderer 应贯通该关联；否则必须明确单请求
   串行规则。

RDP-002 的状态在 A3-01 至 A3-04 的契约测试和实现门禁通过前记为
`NEEDS_ALIGNMENT`；这些决策本身已冻结，后续实现只能关闭风险，不能重新引入双路径或
隐式帧格式。
