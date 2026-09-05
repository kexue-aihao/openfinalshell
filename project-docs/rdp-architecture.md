# 嵌入式 RDP 架构契约

> ARCH-01；版本 1；2026-09-03
>
> 本文是 `project-docs/rdp-task-matrix.md` 的协议补充。它冻结 Worker、Electron
> main、preload 和 renderer 之间的行为，后续实现任务不得自行改变字段、状态或失败语义。

## 1. 目标与边界

嵌入式 RDP 的目标是 Windows、macOS、Linux 桌面端在同一个 Electron 窗口的 `rdp`
session tab 中显示和操控远端桌面。FreeRDP 运行在每会话一个隐藏 Worker 进程中；Worker
不创建窗口、不启动 `mstsc`、不监听本地 TCP 端口。renderer 只负责画面和输入，凭据与
FreeRDP 生命周期由 main 管理。

v1 只实现桌面画面、键盘、鼠标、动态分辨率、TLS/NLA、证书一次性确认和基础剪贴板。
服务端模式、音频、打印机、磁盘、摄像头、智能卡、USB、设备重定向、多显示器和长期
证书信任库不在本契约内。Android 只保留共享 profile/schema 的可解析性。

系统 RDP 客户端是显式降级动作：用户点击“使用系统远程桌面”后才调用现有
`conn:launchRdp`。Worker 缺失、版本不兼容或连接失败不能自动打开外部窗口。

## 2. 进程与数据流

```text
RdpPane (renderer)
  |  MessagePort: binary frame / frameAck only
  |  typed preload IPC: open / close / reconnect / input / resize / clipboard / fallback / prompt reply
  v
main: RdpSessionManager
  |  child stdin/stdout（每个 session 一个 Worker）
  v
rdp-worker (FreeRDP)
  |  TLS/NLA/RDP
  v
远程 Windows RDP 服务
```

`RdpSessionManager` 是会话事实来源。renderer 不读取 Worker 路径、PID、FreeRDP 错误
细节或凭据；renderer 只收到状态、提示和画面。Worker 的 stderr 仅供 main 记录脱敏诊断，
绝不转发为带有连接参数的 renderer 错误。`MessagePort` 不承载 JSON 控制消息或剪贴板；
所有输入、resize、剪贴板和生命周期命令均经 preload 白名单的 typed IPC 进入 main。

### 2.1 会话标识与拥有权

- `sessionId` 由 main 生成，使用现有运行期 `SessionId` 规则；一个 profile 可以同时打开多个 RDP session。
- 一个 Worker 只能绑定一个 `sessionId`，不能在连接中途改 host、port 或 username。
- `rdp:open` 成功返回 `{ sessionId }`，状态事件可能早于 invoke 返回；renderer 必须像 SSH
  一样暂存未认领状态，收到结果后认领 tab。
- `rdp:reconnect` 复用原 `sessionId`，先向旧 Worker 发送 `CLOSE(reconnect)`，等待其报告
  `closed`/退出，2 秒超时才终止进程，随后创建新 Worker；每代 Worker 以 main 内部对象身份
  区分，旧 Worker 的迟到 frame、state 和 prompt 即使 sessionId 相同也必须丢弃。

## 3. Worker framed protocol

Worker stdin/stdout 均使用同一套小端序长度帧。每一帧先发送 16 字节头，再发送 payload；
不允许裸 JSON、换行协议或本地 socket。

### 3.1 固定头

| 偏移 | 长度 | 类型 | 含义 |
| ---: | ---: | --- | --- |
| 0 | 4 | `char[4]` | magic，固定 ASCII `OFSR`（字节 `4f 46 53 52`） |
| 4 | 2 | `uint16` | protocol version，固定 `1` |
| 6 | 1 | `uint8` | message type，见 3.2 |
| 7 | 1 | `uint8` | flags，v1 必须为 `0`，未知位拒绝 |
| 8 | 4 | `uint32` | payload length，最大 `67108864`（64 MiB） |
| 12 | 4 | `uint32` | request id，`0` 表示无应答的事件 |

所有整数均为 little-endian。长度只表示 payload，不包括头；解析器必须先检查 magic、
version、flags 和长度，再分配内存。长度超过上限、整数溢出、EOF 截断或连续读取超过
64 MiB 都是协议错误，main 立即终止 Worker 并将 session 置为 `failed`。

### 3.2 message type 编号和方向

控制 payload 均为 UTF-8 JSON，JSON 对象必须有 `op` 字段；未知 `op` 或缺少必填字段
按协议错误处理。`FRAME` 是唯一非 JSON payload。

| 编号 | 名称 | 方向 | payload |
| ---: | --- | --- | --- |
| `0x01` | `HELLO` | Worker → main | `{op:"hello",protocol:1,workerVersion,capabilities: string[]}` |
| `0x02` | `HELLO_ACK` | main → Worker | `{op:"helloAck",protocol:1,sessionId,maxPayload:67108864}` |
| `0x10` | `START` | main → Worker | 连接参数、显示参数和功能开关；不得含密码 |
| `0x11` | `CREDENTIAL` | main → Worker | 密码或证书应答，格式见下；密码仅发送一次 |
| `0x12` | `CLOSE` | main → Worker | `{op:"close",reason:"user"|"reconnect"|"shutdown"}` |
| `0x13` | `RESIZE` | main → Worker | `{op:"resize",width,height,dpi}` |
| `0x14` | `KEY` | main → Worker | `{op:"key",scanCode,pressed,extended,unicode?}` |
| `0x15` | `POINTER` | main → Worker | `{op:"pointer",x,y,buttons,wheelX,wheelY}` |
| `0x16` | `CLIPBOARD_SET` | main → Worker | `{op:"clipboardSet",mime:"text/plain",text:string}` |
| `0x17` | `CLIPBOARD_GET` | main → Worker | `{op:"clipboardGet",requestId}` |
| `0x20` | `STATE` | Worker → main | `{op:"state",state,errorCode?}` 或控制确认 `{op:"ack"}` |
| `0x21` | `PROMPT` | Worker → main | `{op:"prompt",kind:"certificate",requestId,payload}` |
| `0x22` | `CLIPBOARD_DATA` | Worker → main | `{op:"clipboardData",mime:"text/plain",text}` |
| `0x30` | `FRAME` | Worker → main | BGRA8 dirty-rectangle payload，见 3.3 |
| `0x7f` | `ERROR` | Worker → main | `{op:"error",code,message}`，message 必须脱敏 |

main 发起的 request id 是单调递增的 `uint32`，溢出后从 `1` 重新开始；同一 session 内
不得同时复用未完成的 request id。`HELLO` 是 Worker 事件，帧头 request id 固定为 `0`。
Worker 发出的证书 `PROMPT` 必须使用非零 request id，JSON 的 `requestId` 与帧头完全相同；
main 的证书 `CREDENTIAL` 使用相同帧头 request id 和 JSON `requestId` 回应它。Worker 不信任
来自 main 的 request id，但必须用该关联关系匹配应答。

`HELLO` 必须严格满足 `{op:"hello",protocol:1,workerVersion:string,capabilities:string[]}`。
`workerVersion` 非空且不超过 128 字节；capabilities 无重复，元素只能是
`framebuffer`、`input`、`resize`、`clipboard`、`mock`、`freerdp`，并且必须含有
`framebuffer`、`input`、`resize`。连接要求剪贴板时还必须含 `clipboard`。任一字段不满足时
main 不发送 `HELLO_ACK` 或 `START`，以 `PROTOCOL_MISMATCH` 关闭 Worker。

`CREDENTIAL` 的唯一 v1 payload 为：

```json
{"op":"credential","kind":"password","value":"<in-memory secret>"}
```

密码由 main 的 Vault 或一次性 `rdp-password` 提示取得，绝不来自 profile 明文字段。证书
应答的唯一 v1 payload 为：

```json
{"op":"certificate","requestId":42,"accept":true}
```

其中 `42` 必须同时等于 `CREDENTIAL` 帧头和待应答 `PROMPT` 的 request id。取消或超时发送
相同关联的 `accept:false`；不匹配、重复或迟到的应答一律丢弃。

`START` 的 JSON 固定为：

```json
{
  "op": "start",
  "host": "rdp.example",
  "port": 3389,
  "username": "alice",
  "domain": "",
  "gateway": null,
  "display": {"width": 1280, "height": 720, "dpi": 96},
  "features": {"clipboard": true, "certificatePolicy": "prompt"}
}
```

`host` 必须为非空主机名/IP，`port` 为 1..65535，`width`/`height` 为 320..8192，`dpi`
为 96..384。`gateway` v1 固定为 `null`；收到其他值时以 `UNSUPPORTED` 失败，不静默忽略。

### 3.3 FRAME payload

`FRAME` payload 由下列帧头和矩形数组组成，所有整数 little-endian：

```text
offset  size  field
0       4     canvasWidth (u32)
4       4     canvasHeight (u32)
8       4     sequence (u32, 单调递增)
12      2     rectCount (u16, 1..1024)
14      2     reserved (必须为 0)
随后每个矩形：
        4     x (i32)
        4     y (i32)
        4     width (u32)
        4     height (u32)
        4     stride (u32，至少 width*4)
        4     byteLength (u32，必须等于 stride*height)
        N     BGRA8 行数据，逐行、无压缩、无 padding
```

矩形必须完全位于画布内，`stride*height`、所有矩形总字节数和 payload 长度都必须通过
64 MiB 限制。Worker 在无法生成脏矩形时发送一个覆盖整个画布的矩形。`sequence` 相同或
倒退的帧由 main 丢弃。renderer 以 `canvasWidth/Height` 建立固定 backing store，将矩形
按坐标拷贝到 WebGL 纹理；WebGL2 不可用时使用 Canvas2D `putImageData`，不得 PNG/base64。

## 4. Renderer MessagePort 与背压

每个 session 建立一个 Electron `MessageChannel`。main 用 `webContents.postMessage` 将
一端转移给 renderer，另一端留在 `RdpSessionManager`。preload 增加专用的端口订阅入口，
不把 `MessagePort` 暴露为通用 Node API。

端口消息采用结构化对象：

- main → renderer：唯一格式为
  `{kind:"frame",sequence,canvasWidth,canvasHeight,buffer:ArrayBuffer}`。
- renderer → main：唯一格式为 `{kind:"frameAck",sequence}`。

每个端口最多保留 2 个按 sequence 索引的未确认帧（包括正在显示的一帧）。收到第三帧时，
main 只保留一个可替换的 latest-wins 帧，并暂停 Worker stdout；随后到达的帧替换该本地帧，
不会形成数组队列。`ArrayBuffer` 必须使用 transfer list 转移，转移后发送方不得再读写该
buffer。renderer 在完成纹理上传/Canvas 绘制后立即发送 `frameAck`。main 收到匹配 sequence
的 ack 后删除该账本项、转发 latest-wins 帧并恢复 stdout；没有 ack 时 500 ms 后使对应账本
项过期，再按同一规则恢复。当前 data chunk 会被解析并折叠为最新帧，未解析输入上限为一帧
加 128 KiB，避免 Node 管道或 main 堆内存无限增长。队列长度和丢帧计数仅用于脱敏诊断，
不展示连接参数。

窗口 resize 事件在 renderer 侧 100 ms 防抖，main 侧再次限制为每 100 ms 一次；宽和高的
最小值都为 320、最大值都为 8192，总像素不得超过 16,777,216。renderer 与 main 使用同一
钳制算法，main 保存最后一次钳制结果用于重连。v1 没有独立的“实际尺寸”回发控制通道；
Worker 接受 resize 后，后续 `FRAME.canvasWidth/canvasHeight` 是 renderer 使用的实际尺寸事实源。

### 4.1 键盘映射

renderer 使用 `KeyboardEvent.code` 到 RDP Set-1 scan code 的固定、物理键位映射，不能使用
已废弃且随布局变化的 `keyCode`。`ControlRight`、`AltRight`、`MetaLeft/Right`、导航键、
`NumpadEnter`、`NumpadDivide`、`PrintScreen` 的 `extended=true`；其余标准键为 false/省略。
实现支持 Escape、数字行、字母行、标点、修饰键、F1-F12、数字小键盘、方向/导航和 Meta/Menu
键。未知 `code`（例如浏览器媒体键）安全忽略。可打印字符仅在 key-down 附带可选 Unicode
code point，键位控制仍以 scan code 为准。

## 5. 会话状态机

公开 `SessionState` 与现有 SSH 保持兼容；RDP 的扩展状态只在 `rdp:state` payload 内部
使用，不让旧 SSH UI 依赖新值。

```text
idle
  -> starting       spawn Worker
  -> handshaking    HELLO/HELLO_ACK
  -> connecting     START 已发送，等待 FreeRDP 连接
  -> authenticating 密码/NLA 交互
  -> verifying      证书一次性确认
  -> ready-pending  Worker 报告 ready，仅作为 main 内部标志，不向 renderer 发布
  -> ready          ready-pending 且首个有效 FRAME 已收到，输入通道此时才开放
  -> reconnecting   连接中断且用户/策略要求重连
  -> closing        已发送 CLOSE，等待 Worker 退出
  -> closed         用户关闭或正常结束
```

`ready-pending` 不是共享类型，也不产生 `rdp:state`；若有效 FRAME 先到，则 main 同样等待
Worker `ready`，两个条件全部满足时只发布一次 `ready`。任一阶段发生不可恢复错误都转
`failed`（携带稳定 `errorCode`），随后进入 `closing`；Worker 报告 `closed`、退出或 2 秒终止
截止时间到达后最终为 `closed`。失败/关闭后的会话记录至少保留 profileId 和已钳制 display，
供显式重连和系统客户端降级使用；用户关闭 tab 或应用退出后才移除。只有 `ready` 之后才允许
输入、剪贴板和 resize；其余调用返回 `SESSION_NOT_READY`。重连必须先完成旧 Worker 清理。

稳定错误码：`WORKER_MISSING`、`WORKER_START_FAILED`、`PROTOCOL_MISMATCH`、
`PROTOCOL_ERROR`、`AUTH_FAILED`、`CERTIFICATE_REJECTED`、`UNSUPPORTED`、
`NETWORK_ERROR`、`WORKER_CRASHED`、`SESSION_NOT_READY`、`CANCELED`。错误 message
只允许描述类别和建议动作，不得包含密码、完整 command line 或敏感连接选项。

## 6. 凭据、证书与提示

1. main 从 `profile.rdp.passwordRef` 读取 Vault；成功读取的明文只存在 main 的局部内存。
2. 无引用或 Vault 不可用时，main 通过现有 PromptHost 的 `session:prompt`/`session:promptReply`
   机制发送 `kind:"rdp-password"`，payload 仅含 username/host。用户可选择一次性使用或记住；
   选择记住才由 main 写 Vault，renderer 永远只见 `remember` 结果。
3. main 将密码作为一次 `CREDENTIAL` 消息发送后立即清空临时变量；禁止命令行参数、环境变量、
   `.rdp`、profile 持久字段和日志出现明文。Worker 日志过滤 `password|secret|credential` 键。
4. `START.features.certificatePolicy` 是必填枚举 `"prompt" | "strict"`，由 main 从连接 profile
   冻结后下发，Worker 必须严格解析，缺失或未知值均视为协议错误。`strict` 模式下 FreeRDP
   必须直接拒绝未知或变更证书，不发送提示；若 Worker 仍错误发送证书 `PROMPT`，main 也必须
   直接回复同 request id 的 `{op:"certificate",requestId,accept:false}`，不得调用 PromptHost。
5. `prompt` 模式下 FreeRDP 报告未知或变更证书时发送 `PROMPT kind:"certificate"`，payload 为
   host、port、subject、issuer、SHA-256 fingerprint 和 `changed`。PromptHost 只提供“本次允许”
   和“取消”；v1 不提供长期信任按钮。取消发送 `ok:false`，Worker 以
   `CERTIFICATE_REJECTED` 失败。
6. 密码 prompt 超时 120 秒自动取消；证书 prompt 超时 60 秒自动取消。关闭 session 时所有
   未完成 prompt 以 `ok:false` 完成，迟到的 reply 按 request id 丢弃。

## 7. 关闭、重连与降级

- 用户关闭：main 标记 `closing`，发送 `CLOSE(user)`，等待 Worker 的 `closed` 或进程退出；
  期间不提前发 `closed`。2 秒仍无响应才终止进程，随后清理端口、计时器和临时内存并发
  `closed`。用户主动关闭不是连接错误，不附加错误码。
- 应用退出：`before-quit` 首次触发必须 `preventDefault()`，并发向所有 Worker 发送
  `CLOSE(shutdown)`，等待全部结束（每个 Worker 内部最多 2 秒）后才能关库；防重入守卫随后
  只调用一次 `app.quit()` 完成退出。不得在退出钩子中打开系统客户端。更新安装路径遵循相同
  顺序，必须等待 `closeAll()` 后才可 `closeDatabase()` 和 `quitAndInstall()`。
- Worker 异常退出或管道 EOF：发 `WORKER_CRASHED`，保留 tab 并显示重连和系统客户端按钮；
  不自动创建外部窗口。用户点重连才重新建立 Worker。
- Worker 不存在、架构不匹配或协议握手失败：状态为 `failed`，`rdp:systemFallback` 可显式
  调用现有 `conn:launchRdp`；fallback 成功与否只作为一次性 toast，不改变 tab 状态。
- 重连使用同一个 tab/sessionId；旧 Worker 收到 `CLOSE(reconnect)`，旧端口关闭后新端口重新
  转移，旧端口及旧 Worker 对象的所有消息全部忽略。

## 8. 安全与可观测性约束

- main IPC 继续使用 preload 白名单和 `assertTrustedSender`；所有 rdp invoke 参数在 main
  侧用 zod 校验。preload 对 main→renderer 端口对象执行精确字段检查，只有 `kind:"frame"`、
  `uint32 sequence`、合法整数画布尺寸、总像素上限和真实 `ArrayBuffer` 全部满足时才调用
  renderer listener；`frameAck` 或任意其他对象不会下发。main 对 renderer→main 的
  `{kind:"frameAck",sequence}` 同样执行精确字段和 uint32 范围校验。
- Worker 可执行文件路径只能来自打包的 `resources/rdp-worker`，禁止 renderer 提供路径或参数。
- stdout 解析器和 renderer 合成器拒绝负尺寸、越界矩形、超大 stride、重复 sequence 和未知 flags。
- 日志只记录 sessionId、阶段、稳定错误码、耗时、帧尺寸和丢帧计数；host、username、密码、
  token 和完整 Worker argv 均脱敏或省略。
- main 记录连接建立、首次 ready、关闭、重连次数和 p95 输入延迟；单 session 日志限速
  100 条/分钟，防止远端错误刷屏。

## 9. 验收不变量

- 默认 RDP 连接一定创建应用内 `rdp` tab，正常路径不调用 `shell.openPath`，不出现额外顶层窗口。
- 合成 1920x1080、30 FPS 帧流运行 60 秒时，MessagePort 未确认队列始终 ≤2，内存无持续增长。
- Worker 输入事件 p95 延迟目标 <100 ms；未达标的平台必须在测试记录中给出测量值和原因。
- 畸形头、长度、JSON、矩形和版本均能在单元测试中导致确定的 `PROTOCOL_ERROR`，且 Worker
  退出不会拖垮 Electron main。
- 现有 SSH `session:*`、`term:*`、SFTP、监控和 `conn:launchRdp` 测试全部保持通过。
