# RDP-002 主进程与 IPC 契约审查

> 角色：A3 Backend Architect
> 依赖：RDP-001 PASS
> 审查日期：2026-09-05
> 范围：Electron main / IPC / preload / shared contract / Renderer RDP 接入
> 变更性质：只读审查；本次仅新增本文件，未修改源代码、CI 或既有文档。

## 1. 结论

**A3 结论：有条件通过主进程契约基线，暂不建议无条件冻结 RDP-002。**

当前实现已经形成一条可工作的契约链：Renderer 只能通过类型化 preload API 调用 RDP；main 使用 zod 校验请求；RDP Worker 使用独立的 `OFSR` framed protocol；帧数据优先经专用 MessagePort 转移；会话由 `RdpSessionManager` 统一管理；Worker、MessagePort 和关闭路径都有身份检查。

仍有四项必须在 A2/A3 架构冻结前处理或明确决策的契约问题：

1. `EventMap` 和 Renderer 保留 `rdp:frame` 兼容路径，但当前 `RdpSessionManager` 没有发出该事件，实际帧只走 MessagePort。必须选择删除旧路径，或实现有明确定义的 fallback；不能让两套事实来源长期并存。
2. `RdpFrame.data` 的字节格式没有在 shared contract 中唯一化。Renderer 同时接受整屏原始像素、带 frame header 的 dirty rectangles 和不带 frame header 的 dirty rectangles；main 当前发送的是第三种。需要冻结唯一格式和版本字段。
3. main 事件携带稳定的 `errorCode`，但 `useSessionStore` 只保存 `error` 文本，Renderer 丢弃了稳定错误码。需要决定错误码是否为公开 UI/自动化契约的一部分，并保留它或明确只允许文本。
4. `rdp:systemFallback` 没有在 main 侧限制为失败/关闭状态。当前 IPC 调用可对活动会话启动系统客户端而不关闭 Worker，存在重复连接和资源泄漏风险。

因此，RDP-003 至 RDP-010 可以继续做实现准备和测试设计，但进入并行开发前，A2 架构文档必须对上述选择给出唯一答案，并将本文的验收项纳入门禁。

## 2. 当前契约事实

### 2.1 profile 和敏感字段

- `ConnectionProfile.protocol?: 'ssh' | 'rdp'`，老数据缺省按 SSH 处理；RDP 配置位于可选的 `rdp` 对象中。见 `src/shared/types.ts:156-165`。
- RDP profile 当前字段为 `domain?`、`passwordRef?`、`clipboard?`、`certificatePolicy?: 'prompt' | 'strict'`。见 `src/shared/types.ts:224-233`。
- Renderer 草稿使用 write-only `password?` 和 `clearPassword?`，不直接提交 `passwordRef`。见 `src/shared/types.ts:235-239`。
- main 在 `freezeProfile` 中复制 profile，校验 host、port、domain、clipboard、passwordRef 和证书策略，并为旧 profile 提供 `clipboard=true`、`certificatePolicy='prompt'` 默认值。见 `src/main/rdp/RdpSessionManager.ts:612-633`。
- main 从 Vault 读取密码，密码通过一次性 Worker credential frame 发送，不进入 Worker argv，也不进入 Renderer session state。见 `src/main/rdp/RdpSessionManager.ts:402-427`。
- RDP 密码记忆由 `rememberRdpPassword` 写入 Vault ref；连接 profile 落盘只保留 ref。见 `src/main/store/connections.ts:78-101`、`src/main/store/connections.ts:228-244`。
- 当前编辑页提交 RDP draft 时硬编码 `clipboard: true` 和 `certificatePolicy: 'prompt'`，且没有提交 domain/clearPassword。见 `src/renderer/src/features/connections/ProfileEditDrawer.tsx:143-165`。这属于 RDP-003，但会直接影响本契约的持久化语义。

### 2.2 Renderer -> main invoke 契约

`src/shared/ipc.ts:167-176` 定义了以下公开 RDP invoke：

| Channel | 参数 | 返回 | 当前语义 |
| --- | --- | --- | --- |
| `rdp:open` | `{ profileId, display }` | `{ sessionId }` | 立即返回身份；连接状态异步事件通知 |
| `rdp:close` | `sessionId` | `void` | 等待 Worker 优雅关闭或超时回收 |
| `rdp:reconnect` | `sessionId` | `void` | 关闭当前 Worker 后复用 session id 启动新代际 |
| `rdp:input` | `{ sessionId, input }` | `void` | 仅 ready 会话接受键盘/指针 |
| `rdp:resize` | `{ sessionId, display }` | `void` | 仅 ready 会话接受，main 端节流到 100 ms |
| `rdp:clipboardSet` | `{ sessionId, text }` | `void` | 仅 ready 会话接受，文本上限 1,000,000 |
| `rdp:clipboardGet` | `sessionId` | `void` | 请求远端文本剪贴板，结果走事件 |
| `rdp:systemFallback` | `sessionId` | `void` | 启动系统 RDP 客户端 |

main 注册的 zod schema 与上述 channel 一一对应。见 `src/main/ipc/rdp.ipc.ts:6-42`。

当前边界校验包括：

- session id 长度 1-200。
- display 的宽高 320-8192、DPI 96-384、总像素不超过 `16,777,216`。
- key scan code 0-255，Unicode 必须是合法 Unicode scalar value。
- pointer 坐标 0-8192、buttons 0-255、wheel 数值有界。
- clipboard 文本不超过 1,000,000 字符。
- `registry.handle` 先验证 trusted sender，再用 zod 的解析结果调用 handler；未声明字段不会继续传递。见 `src/main/ipc/registry.ts:21-57`。

### 2.3 main -> Renderer 事件契约

`src/shared/ipc.ts:392-398` 当前公开：

- `rdp:state`: `{ sessionId, state, errorCode?, error? }`
- `rdp:frame`: `{ sessionId, frame }`
- `rdp:clipboard`: `{ sessionId, text }`

`RdpSessionManager.emitState` 只在当前 session identity 仍有效时发状态。见 `src/main/rdp/RdpSessionManager.ts:189-210`。状态和错误码来自同一事件，main 会把错误码转换成当前语言的 `error` 文本。

Renderer 的全局状态订阅集中在 `useSessionStore.wireSessionEvents`：

- `rdp:state` 按 `sessionId` 更新 RDP tab，并将 RDP 状态映射为通用 `SessionState`。见 `src/renderer/src/stores/useSessionStore.ts:100-105、450-465`。
- 尚未认领的 session 状态暂存，最多保留 32 条，`claimRdpSession` 在 `rdp:open` 返回后补认领。见 `src/renderer/src/stores/useSessionStore.ts:84-98、362-372`。
- `rdp:frame` 会写入 `latestRdpFrame` 缓存，但当前 main manager 没有 `emit('rdp:frame', ...)` 调用；实际专用端口发送路径见 `src/main/rdp/RdpSessionManager.ts:256-304、706-737`。
- `RdpPane` 通过 `ofs.connectRdpPort` 接收 transferred `ArrayBuffer`，同时保留 `rdp:frame` legacy fallback。见 `src/renderer/src/features/sessions/RdpPane.tsx:434-487`。

### 2.4 preload 和 MessagePort

- preload 暴露单一 `window.ofs`，没有暴露 `ipcRenderer`。见 `src/preload/index.ts:1-84`。
- `connectRdpPort` 校验 session id，关闭同一 session 的旧 disposer，建立 `MessageChannel`，只通过固定 `RDP_PORT_CHANNEL = 'rdp:port'` 将 port2 发送给 main。见 `src/preload/index.ts:43-78`、`src/shared/ipc.ts:614-624`。
- preload 只把通过 `isRdpPortFrameMessage` 的 frame 交给 Renderer；ack 由 preload 生成并绑定到收到的 frame sequence。见 `src/preload/index.ts:50-70`。
- main 的 `onPort` 仍执行 trusted sender 检查并验证 payload 的 session id。见 `src/main/ipc/registry.ts:68-79`、`src/main/ipc/rdp.ipc.ts:36-42`。
- main 端最多保留两个未确认 frame；第三个及之后只保留 latest replacement，并在 stdout 背压或 500 ms ack 超时后恢复。见 `src/main/rdp/RdpSessionManager.ts:236-305`。
- main 端拒绝来自旧 port 的 ack/close；Renderer 在 RDP 重连时递增 `rdpPortEpoch` 重新绑定端口。见 `src/main/rdp/RdpSessionManager.ts:706-737`、`src/renderer/src/stores/useSessionStore.ts:297-308`。

### 2.5 Worker 生命周期和 OFSR 协议

- Worker 路径在 packaged 环境固定为 `resources/rdp-worker/<exe>`；只有 test/dev 环境允许 `OFS_RDP_WORKER` override。见 `src/main/rdp/RdpSessionManager.ts:90-103`。
- Worker 首帧必须为 request id 0 的 hello；要求 protocol=1、唯一 capability、包含 `framebuffer/input/resize`，打包模式还必须是 `workerVersion='freerdp'` 且不得包含 mock。见 `src/main/rdp/RdpSessionManager.ts:390-399`。
- main 发送 helloAck、start、credential、key、pointer、resize、clipboardSet、clipboardGet、close 等 OFSR frames；RDP profile 的 domain、display、clipboard、certificatePolicy 在 start 中传给 Worker。见 `src/main/rdp/RdpSessionManager.ts:429-451、753-800`。
- Worker 状态只有在收到有效 ready 且已经收到首个有效 framebuffer 后才向 Renderer 发布 ready。见 `src/main/rdp/RdpSessionManager.ts:454-456、494-502、556-563`。
- 证书 prompt 在 main 侧按 request id 去重；strict 直接拒绝，prompt 才通过 `promptBroker` 进入用户交互。见 `src/main/rdp/RdpSessionManager.ts:508-543`。
- Worker 的远端关闭转换为 `NETWORK_ERROR`，main 先进入 closing 再 closed，保留 session 供显式重连或系统 fallback。见 `src/main/rdp/RdpSessionManager.ts:476-491`。
- user close、reconnect、shutdown、failure 都有明确 close reason；关闭最多等待 2 秒，旧 Worker 的事件由 `isCurrent` identity check 丢弃。见 `src/main/rdp/RdpSessionManager.ts:312-377、802-840`。

## 3. 风险和契约缺口

### A3-01 [P1] `rdp:frame` 双路径没有唯一事实来源

证据：`EventMap` 声明了 `rdp:frame`，store 订阅并缓存它，`RdpPane` 还实现 legacy fallback；但是 `RdpSessionManager` 只调用 `sendToPort`，搜索不到 `emit('rdp:frame', ...)`。因此当前生产链路依赖 MessagePort，事件路径实际上是死契约。

影响：

- 测试若只 mock `rdp:frame`，可能通过但不能证明生产帧可见。
- 同一 session 同时接入两个路径时，Renderer 使用 `portDeliveredFrame` 做启发式去重，行为取决于哪条路径先到。
- `latestRdpFrame` 缓存的存在和清理语义会误导后续实现者，把 legacy event 当成可靠补帧机制。

建议：A2 选择一个方案并写入架构文档：

- 推荐：MessagePort 是唯一生产帧路径；删除 `EventMap.rdp:frame`、store 的 `latestRdpFrame` 和 Renderer fallback，保留独立的 port contract 测试。
- 兼容方案：明确 `rdp:frame` 仅用于旧 main/dev mock，并给事件增加版本/来源字段；同时测试禁止生产 main 同时发布两条路径。

验收：RDP-005、RDP-009 必须能证明实际构建应用使用的唯一帧路径；RDP-010 记录该路径的首帧和持续帧证据。

### A3-02 [P1] `RdpFrame.data` 字节格式存在三种隐式变体

`RdpFrame` 只声明 `sequence/canvasWidth/canvasHeight/data`。见 `src/shared/types.ts:331-337`。Renderer 的 `decodeRdpRects` 同时接受：

1. `canvasWidth * canvasHeight * 4` 的完整 BGRA buffer；
2. 带 16-byte frame header 的 dirty-rect stream；
3. 不带 frame header、直接从 rectangle header 开始的 dirty-rect stream。

当前 main 的 `parseFramePayload` 验证 Worker payload 后去掉 16-byte frame header，只把 rectangle bytes 放入 `data`。见 `src/main/rdp/RdpSessionManager.ts:132-156`。这与 Renderer 的第三种解析分支相容，但没有在 shared 类型或 IPC 文档中声明，且 `rdp:frame` 旧路径可以携带不同格式。

影响：格式升级只能靠双方实现细节；错误格式可能在一个 Renderer 分支被静默接受；不同平台 Worker 不能仅凭 TypeScript 类型判断兼容性。

建议：冻结 `rdp-frame-v1` 的单一表示，至少明确：`format`、header 是否包含、rect count、rect 字段顺序、stride、像素顺序、最大 rect 数、payload 上限和 sequence 语义。更稳妥的长期方案是把已验证的 `rects` 元数据作为结构化对象，把像素 buffer 单独转移，但需评估 IPC 拷贝成本。

验收：RDP-005 必须覆盖整屏、单 dirty rect、多 rect、stride padding、损坏长度、超 rect 数、超像素和超 64 MiB payload；main 与 Renderer 对同一 corpus 得出相同接受/拒绝结论。

### A3-03 [P1] 稳定错误码在 Renderer 被丢弃

main 发布 `{ errorCode, error }`，但 `wireSessionEvents` 的 RDP listener 只解构 `error`，`SessionTab` 也只有 `error?: string`。见 `src/shared/ipc.ts:396-398`、`src/renderer/src/stores/useSessionStore.ts:450-464`。

影响：UI 可以显示文本，但无法稳定区分 Worker 缺失、认证失败、证书拒绝、协议错误和网络断开；自动化恢复、遥测、可访问性和多语言一致性也只能依赖文本。

建议：把 `RdpErrorCode` 作为事实字段保留到 tab/view-model，文本只作为展示字段；Renderer 根据 code 做 retry/fallback/提示决策。若产品明确不公开 code，则应从 EventMap 删除或标注 internal，并保证错误分类另有测试覆盖。

### A3-04 [P1] `systemFallback` 缺少状态前置条件

`systemFallback(sessionId)` 只检查 session 是否存在，随后直接调用 `launchRdp`，没有确认 session 已 failed/closed，也没有关闭活动 Worker。见 `src/main/rdp/RdpSessionManager.ts:819-823`。

影响：恶意或错误的 Renderer 调用可以让同一 profile 同时存在嵌入式 Worker 和系统客户端；系统 fallback 也可能在连接仍活跃时绕过用户对当前会话的关闭意图。

建议：main 侧只允许 `failed`/`closed` 状态调用，或先以明确的 `fallback` close reason 关闭当前 Worker，再启动系统客户端；需要定义重复调用的幂等返回值。RDP-010 应增加“活动会话调用 fallback 被拒绝或先关闭”的测试。

### A3-05 [P2] 公共状态机没有写明合法转换和终端态语义

shared 只给出状态数组；Renderer 将 `starting/handshaking/connecting/verifying/closing/failed/closed` 压缩为通用 `SessionState`。见 `src/shared/types.ts:270-302`、`src/renderer/src/stores/useSessionStore.ts:100-105`。

当前实现的实际转换是：

```text
starting -> handshaking -> connecting
connecting -> authenticating | verifying | ready | failed
ready -> closing | failed | reconnecting
failed -> closing -> closed
remote closed -> closing(NETWORK_ERROR) -> closed
closed --explicit reconnect--> reconnecting -> starting
```

其中 ready 还要求 `workerReady && firstFrameReceived`；`RdpPane` 只在 `tab.state === 'connecting'` 时显示 loading，`authenticating/verifying/reconnecting` 可能保留 canvas 但不可控制。A2 需要明确每个状态的可见 UI、是否允许 input/resize/clipboard、是否允许 close/reconnect/fallback，以及 `closed` 是否仍保留 session identity。

### A3-06 [P2] session id 稳定但没有公开 generation/epoch

main 用 Session 对象 identity 阻止旧 Worker 事件，Renderer 另用 `rdpPortEpoch` 重新绑定 port。这能防住当前实现中的旧 Worker/旧 port，但 `EventMap` 只有 `sessionId`，没有 generation；MessagePort frame 也没有 generation。

建议：至少在内部日志和测试证据中记录 worker generation；若未来支持多窗口、跨进程缓存或事件重放，考虑把 `generation` 加入 state/frame/clipboard 事件，并要求 Renderer 丢弃非当前 generation 的事件。若保持当前 session id 复用方案，A2 必须明确：session id 是逻辑会话身份，port epoch 是传输代际，不得混用。

### A3-07 [P2] clipboard 结果缺少请求关联

`clipboardGet` 为每次请求分配 Worker request id，但 `handleClipboard` 只接受 `{ op:'clipboardData', mime:'text/plain', text }` 并直接发 `rdp:clipboard`，没有 request id。见 `src/main/rdp/RdpSessionManager.ts:546-554、796-800`。

单次请求没有问题，但并发 copy、远端主动剪贴板更新和重连边界下无法区分响应属于哪次请求。建议 v1 明确“每会话最多一个 outstanding clipboardGet，后续请求合并/拒绝”，或把 request id 贯通到 Worker、EventMap 和 Renderer。

### A3-08 [P2] pointer 边界只校验协议上限，不校验当前 display

IPC 允许 x/y 到 8192；main 转发前没有按 `session.display` 或最近 framebuffer 尺寸收窄，Worker/native 需要自行处理越界坐标。建议在 A2 冻结“坐标空间是当前 framebuffer，越界由 main clamp 还是拒绝”的规则，并在 RDP-004/RDP-010 覆盖 resize 后的输入坐标。

## 4. 建议冻结的字段与生命周期

### 4.1 Profile 字段规则

| 字段 | 公开层类型 | 默认值 | 生命周期规则 |
| --- | --- | --- | --- |
| `protocol` | `'ssh' | 'rdp'` | 老数据按 `ssh` | 切换协议时不误用另一协议字段 |
| `rdp.domain` | `string?` | `''` | 保存/编辑必须保留；空值与未设置语义一致 |
| `rdp.passwordRef` | `SecretRef?` | 无 | 只能由 main/Vault 持有；Renderer 只能 write-only 设置或 clear |
| `rdp.clipboard` | `boolean?` | `true` | 旧 profile 缺省 true；编辑不得硬编码覆盖用户值 |
| `rdp.certificatePolicy` | `'prompt' | 'strict'` | `prompt` | 连接开始时冻结到 session；strict 不进入 Renderer prompt |

profile 保存必须满足：

- 明文密码只在 `ProfileDraft` 保存调用和 RDP password prompt 的短生命周期存在。
- `passwordRef` 不进入普通 Renderer state、日志、argv 或 Worker 命令行。
- 编辑已有 RDP profile 时 domain、clipboard、certificatePolicy 和既有 passwordRef 都保持不变，除非用户显式修改或清除。
- profile 在 `rdp:open` 时冻结；会话运行期间 profile 编辑不改变当前 Worker，下一次 open/reconnect 才生效。
- 删除或切换协议时清理独占 RDP password Vault ref，不能留下 orphan secret。

### 4.2 Invoke 契约规则

- 所有 RDP invoke 都必须有 zod schema，并使用 schema 解析后的值。
- 所有需要 session 的操作必须先进行 session identity、状态和 capability 检查。
- `rdp:open` 返回逻辑 session identity，不承诺 ready；ready 只能由事件发布。
- `rdp:close` 应幂等；已不存在的 session 返回成功或稳定的 not-found 语义需在架构文档中固定。
- `rdp:reconnect` 应幂等/可串行化；必须定义并发 reconnect、close 与 shutdown 的优先级。
- `rdp:systemFallback` 只在允许状态执行，且不得留下活动 Worker。
- 大 payload 只允许专用 MessagePort；普通 `rdp:frame` event 若保留，必须声明为兼容/测试路径。

### 4.3 Event 和 port 契约规则

- state event 是低频、可丢失、可按 session id 重建的通知；若 UI 需要最终状态，必须有 snapshot/query 或 claim 时的稳定补偿机制。
- error code 是机器可判定字段，error text 是展示字段；两者不能互相替代。
- frame event/port 必须定义唯一格式、sequence 单调性、generation/epoch 关系和 ACK 语义。
- port 关闭必须使 main 停止向该 port 发送并恢复/暂停 stdout 的行为可测试；新 port 不得收到旧代未确认帧。
- clipboard event 必须定义是“远端主动更新”还是“clipboardGet 响应”，以及并发/重连时的顺序规则。

## 5. 与 A2 架构文档必须对齐的事项

当前仓库中尚未发现 `project-docs/rdp-native-architecture.md`，因此本文不能引用一个已经冻结的 A2 版本。A2 文档至少必须补齐以下内容：

1. **范围和平台**：Windows x64 原生 Worker 是当前必做；macOS/Linux/Windows ARM64 是 unsupported、system fallback 还是待开发，必须逐平台写明。系统 fallback 不得被表述为 embedded RDP 支持。
2. **profile schema**：字段默认、旧 profile 兼容、编辑保留、Vault ref、clearPassword 和协议切换清理规则。
3. **secret boundary**：Renderer、main、Worker argv、Worker stdin、日志和 crash dump 的允许/禁止字段。
4. **IPC truth source**：明确 `rdp:frame` event 与 `rdp:port` 的取舍；明确 `rdp:state` 的 errorCode 是否保留到 Renderer。
5. **frame format**：固定 v1 header/rect/stride/pixel order/limits，禁止 Renderer 和 main 各自支持未声明的隐式变体。
6. **state machine**：给出合法转换图、状态可操作矩阵、终端态、失败后 fallback 和 reconnect 语义。
7. **generation model**：区分逻辑 `sessionId`、Worker generation、`rdpPortEpoch`，定义旧事件隔离。
8. **lifecycle ownership**：明确 tab、manager session、Worker、MessagePort、PromptBroker request 和 latest frame 的创建/销毁责任。
9. **backpressure**：固定最多两个 in-flight frame、latest-wins、ACK timeout、stdout pause/resume 和 port replacement 规则。
10. **capability/degradation**：Worker hello capability 如何影响 clipboard、resize、input；缺失 Worker、mock Worker 和真实 FreeRDP Worker 的用户可见差异。
11. **clipboard/certificate**：证书 prompt/strict、请求关联、超时、拒绝和远端主动剪贴板更新规则。
12. **security and release**：trusted sender、Worker 路径信任、签名、依赖许可证/SBOM/CVE 和平台发布门禁的责任归属。

在上述决策落地前，A2/A3 的 RDP-002 状态应保持 `NEEDS_ALIGNMENT`，不得把后续实现中的临时兼容行为当成冻结契约。

## 6. RDP-003 至 RDP-010 后端验收检查项

### RDP-003：配置编辑与持久化

- [ ] main 接收到的 `ProfileDraft.rdp` 能区分“未修改 password”和“clear password”。
- [ ] domain、clipboard、certificatePolicy 在新增、编辑、取消、保存中有明确结果；编辑不被默认值覆盖。
- [ ] 清除 RDP 密码删除 Vault ref，profile JSON 不含明文。
- [ ] 老 profile 缺失 `rdp` 可读；缺失 clipboard/policy 时按冻结默认值处理。
- [ ] RDP profile 切换为 SSH 后旧 RDP secret 清理且当前活动 session 不被静默改写。
- [ ] 保存失败、Vault 不可用、profile 不存在均返回稳定错误，不回显密码。
- [ ] IPC 契约测试覆盖额外字段剥离、非法 domain/policy/clipboard 和敏感日志检查。

### RDP-004：Unicode、键盘布局和 IME

- [ ] Renderer `RdpInput` 的 scanCode、extended、pressed、unicode 到 main zod、OFSR key frame、FreeRDP API 的字段逐跳可追踪。
- [ ] native 明确 Unicode API 与 scan-code API 的优先级，不能只在 TypeScript 层携带 `unicode` 后静默丢弃。
- [ ] main 对 Unicode scalar、scan code、extended 组合键和重复 keyup 做一致校验。
- [ ] session 非 ready、closing、旧 generation 的输入全部拒绝或丢弃且有可诊断结果。
- [ ] 失焦释放 pressed keys；重连/关闭不会把旧按键状态带入新 Worker。
- [ ] 中英文及至少一种日文/韩文或 IME 场景有真实链路证据；环境不足时标记 `BLOCKED_EXTERNAL_ENV`。

### RDP-005：帧传输、校验和稳定性

- [ ] 架构文档和 shared contract 只保留一个 `rdp-frame-v1` 字节格式。
- [ ] main、preload、Renderer 对 width/height/stride/rect count/byteLength/pixel limit/64 MiB 上限的接受结果一致。
- [ ] 证明生产帧只走选择后的唯一 transport；不存在 event/port 双发或旧缓存覆盖新帧。
- [ ] sequence 在单个 Worker generation 内严格递增；reconnect 后 generation/epoch 变化不会误判新 sequence 为旧帧。
- [ ] ACK 只确认真实收到的 sequence；旧 port、未知 sequence、重复 ACK 和伪造 metadata 不改变背压状态。
- [ ] malformed frame 不会让 main 或 Renderer 永久停在 paused；ACK timeout、latest-wins 和 port replacement 有测试。
- [ ] 1920x1080 及高分辨率连续帧下记录 payload、CPU、内存和丢帧数据。

### RDP-006：Worker、构建和平台矩阵

- [ ] hello capability 与 `requireFreerdpWorker` 的生产策略一致；mock 不进入生产包。
- [ ] Worker 缺失、启动失败、协议 mismatch、crash 均通过 `rdp:state` 产生稳定 code 和用户可见结果。
- [ ] `rdp:open` 在 Worker 尚未 ready 时返回 session id 的语义被 Renderer 和测试接受；不会把 open resolve 当作 ready。
- [ ] reconnect/closeAll 在 Worker stdout、stderr、exit、error 顺序任意时不重复发终态、不遗留进程。
- [ ] `npm run dev` 的 Worker 定位策略、资源 staging 和 packaged path 在 A2 文档中一致。
- [ ] unsupported 平台不会误报 embedded capability，也不会打包 mock 充当 native RDP。

### RDP-007：许可证、SBOM、CVE 与发布安全

- [ ] 依赖清单与 Worker hello/version、最终 DLL/动态库和发布产物可追溯。
- [ ] 原生依赖的许可证、NOTICE、源码归属要求不通过“存在任意 LICENSE 文件”替代。
- [ ] SBOM 和 CVE 结果作为发布门禁输入；不可接受漏洞或缺失许可证会阻断发布。
- [ ] 日志、崩溃收集和诊断包不包含 password、passwordRef 对应明文或认证 frame payload。
- [ ] Worker 资源完整性/签名检查失败时，main 返回稳定的 Worker failure，而不是静默降级。

### RDP-008：代码签名、公证和平台信任

- [ ] Windows 应用和 Worker 的签名范围、证书链、时间戳和验证命令已固定。
- [ ] macOS 若声称支持，应用、Worker、嵌套动态库、entitlements、公证和 stapling 均有证据；否则明确 unsupported。
- [ ] 被篡改 Worker 不会被 main 当作可信生产 Worker 启动，或至少在发布门禁前被检测。
- [ ] 签名失败阻断 release job；凭据不进入仓库、命令行输出或普通日志。
- [ ] 干净环境安装启动后，Worker 缺失/不可信的错误能落到用户可操作的 fallback/diagnostic 状态。

### RDP-009：性能和长稳

- [ ] 首帧前不会接受 input/resize/clipboard；ready 的判定明确包含首个有效 frame。
- [ ] 记录首帧时间、稳定帧率、丢帧率、main->Renderer payload、CPU、内存增长、输入 p95 和重连恢复时间。
- [ ] 60 秒以上连接、动态 resize、持续输入、clipboard、网络抖动和 Worker stdout 背压可重复。
- [ ] port 关闭、Renderer 隐藏/卸载、GPU/Canvas context loss 后不会泄漏 Worker、timer、frame buffer 或 prompt request。
- [ ] 性能阈值由 A8/A0 预先确认；不达标产生任务，不修改契约文字掩盖结果。

### RDP-010：真实服务器端到端

- [ ] accepted certificate 和 rejected/strict certificate 都有真实服务器证据；strict 不进入 Renderer prompt。
- [ ] 成功认证、错误密码、domain、首帧、输入、动态 resize、clipboard、远端断开、客户端 close、reconnect 全部覆盖。
- [ ] 真实服务器测试使用最终 FreeRDP Worker/最终应用产物，不使用 mock 或仅浏览器 mock。
- [ ] 记录每个场景的 session id、generation/port epoch、state sequence、error code 和关键截图/日志，但不记录密码。
- [ ] 验证旧 Worker、旧 MessagePort、迟到 frame/ACK 在 reconnect 后不会污染新会话。
- [ ] 验证活动 session 调用 system fallback 的冻结语义：被拒绝，或先完成可观察的关闭再启动系统客户端。
- [ ] 若缺少授权服务器、账号、证书场景或故障注入条件，结论必须是 `BLOCKED_EXTERNAL_ENV`，不能用 unit/mock 测试替代。

## 7. A3 建议的契约测试增量

不要求本轮立即修改源代码，但 RDP-002 通过前应把下列测试计划交给 A9：

1. 对 `InvokeMap`、zod schema、preload allowlist 做三方 channel/字段同步检查。
2. 对 `rdp:frame` 事件和 `rdp:port` 做“单路径”断言，防止未来重新出现双发。
3. 对每个 `RdpErrorCode` 验证 main event、store view-model、Renderer 操作决策均保留分类。
4. 对状态机执行合法/非法转换矩阵，尤其是 `ready -> reconnecting`、`closing -> ready`、旧 generation event 和重复 close。
5. 对 `systemFallback` 的 active/failed/closed/unknown session 行为建立 main-side tests。
6. 对 clipboard 并发请求、远端主动更新、重连中响应建立 correlation/ordering tests。
7. 用同一 frame corpus 同时测试 main parser、preload validator 和 Renderer decoder，避免三层接受集合漂移。

## 8. 交接结论

本审查确认：RDP main/IPC 主链路已经具备继续工程化的基础，当前自动化测试覆盖了大量安全边界、Worker 生命周期和背压行为；不存在需要因“完全没有后端契约”而推倒重做的理由。

但在 A2 文档补齐并关闭 A3-01 至 A3-04 前，RDP-002 不应标记为无条件 PASS。A2/A3 完成契约选择后，A9 应依据本文第 6 节为 RDP-003 至 RDP-010 建立可复现门禁；真实服务器、签名、依赖合规和性能数据仍按编排计划作为后续独立发布条件。
