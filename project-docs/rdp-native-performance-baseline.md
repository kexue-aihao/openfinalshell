# RDP-009 性能与长稳基线

> 角色：A8 Performance Benchmarker
> 任务：RDP-009
> 基线日期：2026-09-05
> 当前结论：`PARTIAL_BASELINE / BLOCKED_EXTERNAL_ENV`

## 1. 结论

仓库已经有可重复的 host-independent 行为测试，可以证明 RDP 帧队列和背压契约的若干安全边界：

- main 端最多保留两个未确认帧；第三帧进入 latest-wins replacement，并暂停 Worker stdout。
- ACK 或 500 ms ACK timeout 后可以恢复发送。
- renderer 端会丢弃旧帧/跳过帧，并在丢弃或完成画面上传后 ACK。
- MessagePort 替换后，旧 port 的 ACK、close 和旧 Worker 事件不会推进新 port 的队列。

这些测试使用 fake Worker、fake MessagePort 和 fake `requestAnimationFrame`，没有测量真实进程、Electron IPC、Canvas/WebGL、RDP 网络或远端回显。因此当前不能报告 1920x1080、30 FPS、60 秒的真实性能 PASS。

真实性能结论需要同时具备：

1. Windows x64 最终 FreeRDP Worker 或最终打包应用。
2. 授权的可重复 RDP 服务器、账号和证书场景。
3. 真实 Electron renderer，至少各执行一次 WebGL2 和 Canvas2D fallback。
4. 可记录 Worker/main/renderer 三侧时间戳、帧序号、ACK、字节数和进程资源的 harness。

缺少任一项时，RDP-009 的最终状态必须是 `BLOCKED_EXTERNAL_ENV`，不能用 mock 或 unit test 数据替代。

## 1.1 审查输入

- `project-docs/rdp-native-architecture.md`：冻结的帧格式、MessagePort、ACK/backpressure、首帧和状态语义。
- `project-docs/rdp-native-backend-contract-review.md`：A3 对双帧路径、帧格式变体和性能证据要求的审查。
- `project-docs/rdp-native-orchestration-plan.md`：RDP-009 的 1920x1080、30 FPS、60 秒场景及交付依赖。
- `test/unit/rdpSessionManager.test.ts`：main 队列、ACK timeout、pause/resume、port replacement 行为测试。
- `test/renderer/rdpFrameComposition.test.ts`：renderer latest-wins、丢帧 ACK 和 Canvas2D 组合测试。
- `test/unit/preloadContract.test.ts`、`test/unit/rdpContract.test.ts`、`test/renderer/rdpInput.test.tsx`：MessagePort 边界、协议和输入链路测试。

## 2. 当前实现约束

| 项目 | 当前事实 | 基准影响 |
| --- | --- | --- |
| 目标画面 | `canvasWidth * canvasHeight <= 16,777,216`；目标场景为 1920x1080 | 1920x1080 BGRA8 单个完整像素面为 8,294,400 bytes（7.91 MiB） |
| Worker payload | 单帧 payload 上限 64 MiB；dirty rectangle header 为 24 bytes | 必须记录每帧 payload，不能只记录帧数量 |
| 帧格式 | BGRA8 dirty rectangles；main 当前剥离 16-byte frame header 后发送像素/矩形数据 | 要记录 rect 数、dirty area 和原始/转移字节数 |
| 生产通道 | 专用 transferable MessagePort；`rdp:frame` 仍保留为 legacy/mock 兼容路径 | 真实性能测试必须确认只统计 MessagePort，不能双路径计数 |
| main 背压 | 最多两个 pending ACK；一个 latest replacement；ACK timeout 500 ms | 记录 `in_flight_peak`、`replacement_count`、`stdout_pause/resume` |
| renderer 队列 | 有显示帧后最多等待一个新帧；丢弃帧也会 ACK | 同时区分 source、delivered、rendered、dropped，不用 sequence gap 单独推断丢帧 |
| resize | renderer ResizeObserver 触发后 100 ms 节流 | resize 场景必须记录请求时间、实际发送时间和首个新尺寸帧时间 |
| 首帧 | 只有 Worker ready 且收到首个有效 framebuffer 后才发布 ready | 首帧终点固定为首个有效 FRAME 到达 main；另记录 renderer 首次绘制作为辅助指标 |

1920x1080、30 FPS 的满屏原始像素理论吞吐为：

```text
1920 * 1080 * 4 * 30 = 248,832,000 bytes/s = 237.30 MiB/s
```

这只是未压缩、全屏 dirty rectangle 的上限估算，不是实现测量值，也不是允许用来推导 PASS 的假数据。若实现持续产生接近该值的 payload，必须单独评估复制、GC、IPC 和渲染压力。

## 3. Host-independent 可执行基线

### 3.1 已运行命令

以下命令在 `E:\openfinalshell` 执行，结果来自当前工作区：

```powershell
npm test -- --run test/unit/rdpSessionManager.test.ts test/renderer/rdpFrameComposition.test.ts
```

结果：`2` 个 test files，`29` 个 tests passed，耗时约 `3.88s`。

覆盖的行为基线包括：

- 两个 in-flight frame 的上限。
- 第三个和后续 frame 的 latest-wins replacement。
- stdout pause/resume。
- 500 ms ACK timeout 恢复。
- MessagePort 替换及旧 port ACK/close 隔离。
- renderer 队列 latest-wins、跳过帧 ACK 和显示帧上传后 ACK。

```powershell
npm test -- --run test/unit/preloadContract.test.ts test/unit/rdpContract.test.ts test/renderer/rdpInput.test.tsx
```

结果：`2` 个 test files，`9` 个 tests passed，耗时约 `0.75s`。这组测试验证 transferable frame 的边界过滤、协议字段和输入调用链，不是资源性能测试。

```powershell
npm run typecheck
```

结果：`typecheck:node` 和 `typecheck:web` 通过。

```powershell
npm run smoke:rdp-worker -- build/rdp-worker/ofs-rdp-worker.exe
```

结果：命令正常退出，但由于未设置 `OFS_TEST_RDP_HOST`、`OFS_TEST_RDP_USERNAME` 和 `OFS_TEST_RDP_PASSWORD`，脚本输出 `Skipping real RDP worker smoke`。这不是 smoke PASS。

```powershell
ctest --test-dir build/rdp-worker-direct --output-on-failure
```

结果：`No tests were found`。该目录没有可用的 CTest 注册结果，不能计为 native 性能或协议 PASS。

### 3.2 可复用的 host-independent 压力场景

这些场景目前由现有 Vitest 以 fake endpoint 执行，后续应保留为快速回归门禁：

| 场景 | 输入 | 必须观察 | 当前判定 |
| --- | --- | --- | --- |
| H1 正常消费 | 连续递增 sequence；每个 frame 及时 ACK | pending 不超过 2；无 replacement；无 pause 后永久不 resume | 已由 session manager 测试覆盖 |
| H2 renderer 慢消费 | 连续 4 个 frame；不立即 ACK | 只保留最新 replacement；pause 一次；收到 ACK 后发送最新帧 | 已由 session manager 测试覆盖 |
| H3 ACK 丢失 | 两个 frame 后不 ACK | 500 ms timeout 后发送 replacement 并 resume | 已由 session manager 测试覆盖 |
| H4 renderer 队列超载 | 同一 RAF tick enqueue 3 个递增 frame | 旧帧 ACK；只绘制最新可用帧；队列不增长 | 已由 frame composition 测试覆盖 |
| H5 port replacement | 旧 port 有 pending frame，绑定新 port | 旧 port 关闭；旧 ACK/close 无效；新 port 独立推进 | 已由 session manager 测试覆盖 |
| H6 malformed boundary | 非法尺寸、stride、payload、sequence | 被拒绝或进入协议错误；不得无限暂停 | 部分由 contract/parser 测试覆盖，未形成数字吞吐基准 |

这些场景的通过标准是契约安全标准，不等于 1920x1080 的 CPU、内存、FPS 或 IPC 性能通过。

## 4. 真实 60 秒基准方案

### 4.1 固定实验配置

每次运行必须生成唯一 `run_id`，并记录以下配置：

```text
display: 1920x1080
target_fps: 30
duration_s: 60
warmup_s: 10
measurement_s: 60
ack_timeout_ms: 500
max_in_flight: 2
renderer: webgl2 | canvas2d
worker_build_id: file hash + version
app_build_id: package version + git revision
server_profile: redacted name, no password
```

冷启动运行至少 5 次，稳定连接运行至少 3 次。每次运行顺序为：

1. 启动最终应用/Worker，记录 `t_open`。
2. 完成认证和证书策略；不记录密码或 credential payload。
3. 等待首个有效帧，记录 main 收到时间和 renderer 完成首次绘制时间。
4. warmup 10 秒，不纳入稳定 FPS 的汇总，但仍记录错误、峰值内存和队列上限。
5. 以 30 FPS 目标持续 60 秒，包含持续桌面变化、鼠标移动和可控键盘输入。
6. 至少执行一次窗口 resize；记录旧尺寸帧停止、新尺寸帧首达和 renderer 完成时间。
7. 结束时正常关闭；另有独立运行覆盖网络断开和显式 reconnect，不把断线运行混入正常 FPS 汇总。

为了避免只测静止桌面，服务器端场景应产生三种帧流并分别标注：

- `full`: 接近全屏变化，用于上界压力。
- `sparse`: 小面积连续变化，用于 dirty-region 效率。
- `mixed`: 约 10 秒静止、20 秒 sparse、20 秒 mixed、10 秒 full。

如果无法控制远端画面变化，必须记录实际 dirty area 分布，并将结果标为 `LIMITED_SCENARIO`，不能声称覆盖 full/mixed。

### 4.2 指标定义

| 指标 | 定义 | 推荐汇总 |
| --- | --- | --- |
| 首帧 main | `t_first_valid_frame_main - t_open` | p50、p95、最大值 |
| 首帧 renderer | 首次有效 `putImageData`/WebGL upload 完成时间减 `t_open` | p50、p95、最大值 |
| source FPS | Worker 发出的有效 FRAME 数 / measurement seconds | 每 10 秒窗口、总体 |
| delivered FPS | main 成功 post 到当前 MessagePort 的 frame 数 / seconds | 每 10 秒窗口、总体 |
| rendered FPS | renderer 实际完成 paint/upload 的 frame 数 / seconds | 每 10 秒窗口、总体 |
| frame drop | `(source - rendered) / source`，同时单列 queue drop、ACK timeout、invalid drop | 总体及各原因 |
| sequence gap | source sequence 与 delivered/rendered sequence 的差异 | 仅作辅助，不能替代 drop counter |
| dirty area | 每帧所有 rect 的面积和 / canvas 面积 | p50、p95、最大值 |
| frame payload | Worker FRAME payload、main 剥离后 bytes、MessagePort buffer bytes | p50、p95、总 MiB/s |
| in-flight | main `pendingPortFrames.size` | 平均、p95、峰值，峰值必须 <= 2 |
| replacement | `latestFrame` 被覆盖的次数 | 计数及每分钟速率 |
| pause/resume | stdout pause 和 resume 事件及持续时间 | 次数、最长暂停、timeout 恢复时间 |
| CPU | Worker/main/renderer process CPU time 除以 wall time；明确是否按 one-core 或 all-core 归一 | 平均、p95、峰值 |
| memory | Worker/main/renderer RSS；记录 warmup 后基线和结束值 | 起始、p95、最大、结束减基线 |
| IPC | Worker->main bytes、main->renderer transferable bytes；不把 RDP TCP bytes 混入 | 总 bytes、MiB/s、p95 frame bytes |
| input control p95 | renderer 发出 input 到 main/Worker ACK 的 monotonic 时间 | p50、p95、最大值 |
| input visual p95 | input 发出到远端可识别回显帧完成 paint | p50、p95、最大值 |
| reconnect | 断线/重连触发到新 session 首帧完成 | p50、p95、最大值 |

CPU 必须说明归一化方式。Windows 进程 CPU 推荐同时保存原始 `user_ms`、`kernel_ms` 和 `wall_ms`，再保存：

```text
cpu_one_core_pct = 100 * (user_ms + kernel_ms) / wall_ms
cpu_all_core_pct = cpu_one_core_pct / logical_cpu_count
```

不能把 Task Manager 的瞬时百分比和跨平台 `process.cpuUsage()` 结果直接混在一列。

### 4.3 原始数据格式

每个运行目录保存不可变的 `metadata.json`、`samples.jsonl`、`events.jsonl` 和 `summary.json`。密码、credential frame、完整 host/username、服务器地址和证书敏感字段不得写入文件。

`metadata.json` 示例：

```json
{
  "schema": "ofs-rdp-perf-v1",
  "run_id": "20260905T000000Z-win-x64-webgl2-01",
  "status": "PASS|FAIL|BLOCKED_EXTERNAL_ENV|LIMITED_SCENARIO",
  "display": { "width": 1920, "height": 1080, "target_fps": 30 },
  "warmup_s": 10,
  "measurement_s": 60,
  "renderer": "webgl2",
  "worker_build_sha256": "redacted-or-recorded-hash",
  "app_revision": "redacted-revision",
  "logical_cpu_count": 16,
  "os": "Windows 11 build redacted",
  "server_profile": "authorized-rdp-fixture-01"
}
```

每秒一个 `samples.jsonl` 记录：

```json
{
  "run_id": "...",
  "second": 12,
  "source_frames": 30,
  "delivered_frames": 29,
  "rendered_frames": 28,
  "queue_dropped": 1,
  "ack_timeout_dropped": 0,
  "invalid_dropped": 0,
  "payload_worker_bytes": 8294400,
  "payload_port_bytes": 8294400,
  "dirty_area_ratio_p50": 1.0,
  "in_flight_peak": 2,
  "replacement_count": 1,
  "stdout_pause_count": 1,
  "stdout_resume_count": 1,
  "worker_cpu_one_core_pct_avg": 0,
  "main_cpu_one_core_pct_avg": 0,
  "renderer_cpu_one_core_pct_avg": 0,
  "worker_rss_bytes_p95": 0,
  "main_rss_bytes_p95": 0,
  "renderer_rss_bytes_p95": 0,
  "input_control_p95_ms": null,
  "input_visual_p95_ms": null
}
```

`0` 只能由真实采集器写入，不能作为占位值；未采集字段使用 `null`。示例中的数值仅说明 schema，不是本仓库的测量结果。

`events.jsonl` 至少记录：

```json
{
  "t_monotonic_ns": 0,
  "component": "worker|main|preload|renderer",
  "event": "open|first_frame|frame_source|frame_delivered|frame_rendered|frame_dropped|ack|pause|resume|resize|input|reconnect|close|error",
  "sequence": 0,
  "bytes": 0,
  "reason": "queue|ack_timeout|invalid|stale|error"
}
```

## 5. A8 建议阈值

以下是执行 RDP-009 前应由 A0 复核并冻结的建议预算。它们是门槛，不是已达成的结果；在没有真实采样数据时所有项均为 `UNMEASURED`。

| 类别 | 建议 PASS 阈值 | 失败条件 |
| --- | --- | --- |
| 首帧 | main p95 <= 2,000 ms；renderer 首绘制 p95 <= 2,500 ms | 超阈值或出现无首帧连接 |
| 帧率 | rendered 总体 >= 27 FPS；每个 10 秒窗口 >= 24 FPS | 任一稳定窗口低于 24 FPS |
| 丢帧 | 总 rendered drop <= 5%；`invalid_dropped`、协议错误和未知 sequence 均为 0 | 超过 5%，或安全错误非 0 |
| 背压 | `in_flight_peak <= 2`；replacement 只保留 1 个；无未恢复 pause | 超过上限、队列随时间增长或无法恢复 |
| ACK 恢复 | ACK timeout 后恢复发送 <= 550 ms | 超时恢复超过 550 ms或 session 永久停顿 |
| CPU | app 进程组 one-core 平均 <= 70%，p95 <= 90% | 任一稳定窗口超预算，且不能解释为外部系统噪声 |
| 内存 | warmup 后到 60 秒结束 RSS 增长 <= 64 MiB；p95 不超过基线 + 128 MiB | 持续单调增长、增长超过预算或 Worker 泄漏 |
| IPC | 记录全链路；平均不得超过 250 MiB/s；优选 mixed 场景 <= 100 MiB/s | payload 超 64 MiB、吞吐超预算或出现 Buffer/GC 失控 |
| 输入控制 | control ACK p95 <= 50 ms | p95 超 50 ms或 input 未到达 Worker |
| 输入视觉 | 可识别远端回显 p95 <= 200 ms | 无法关联回显或 p95 超 200 ms |
| 长稳 | 60 秒无 Worker crash、renderer context loss 未恢复、协议错误或 session 泄漏 | 任一发生且未完成可观察恢复 |

CPU、内存和 IPC 阈值受机器规格影响，A0 可以在冻结时调整数值，但不得删除原始测量或将缺少观测改为 PASS。任何只运行 H1-H6 的结果最多为 `BEHAVIOR_PASS`。

## 6. 当前缺口与阻塞项

### `BLOCKED_EXTERNAL_ENV`

- 没有配置 `OFS_TEST_RDP_HOST`、`OFS_TEST_RDP_USERNAME`、`OFS_TEST_RDP_PASSWORD` 的授权真实服务器，真实 smoke 已跳过。
- 没有真实 Electron/GPU harness，无法证明 WebGL2 upload、Canvas2D fallback、GPU context loss 和 renderer RSS。
- 当前 RDP manager、MessagePort 和 renderer 没有统一的性能事件计数器，无法从现有自动化测试得到 source/delivered/rendered FPS、IPC bytes、RSS、CPU 和 input p95。
- 当前测试使用 320x320 或 fake endpoint，不满足 1920x1080、30 FPS、60 秒真实性能条件。
- `build/rdp-worker-direct` 的 CTest 配置没有测试，不能作为长稳或 native 性能证据。

### 需要后续实现/测试配合的观测点

1. A5 在 `queueFrame`、`sendToPort`、ACK、timeout、pause/resume 处输出仅含 session generation、sequence、bytes 和 monotonic timestamp 的脱敏诊断事件。
2. A4/A5 在 renderer 记录 enqueue、drop、paint/upload 完成和 ACK 时间；MessagePort 为唯一生产统计来源。
3. A9 提供真实 Electron harness，采集 renderer context 类型、context loss、paint/upload 耗时和进程 RSS。
4. A10 使用授权服务器提供可识别的输入回显，建立 input visual latency 的 request/correlation 标记。
5. A0 复核并冻结本文件第 5 节阈值后，再允许 RDP-009 产生正式 `PASS`。

## 7. 交接判定

| 交付物 | 状态 |
| --- | --- |
| host-independent 背压/帧队列基线 | `BEHAVIOR_PASS`，38 个相关测试断言通过 |
| 1920x1080、30 FPS、60 秒真实帧基线 | `BLOCKED_EXTERNAL_ENV` |
| CPU/RSS/IPC 数字基线 | `UNMEASURED` |
| input control/visual p95 | `UNMEASURED`，真实端点和观测点未具备 |
| GPU/Canvas 长稳 | `BLOCKED_EXTERNAL_ENV` |
| RDP-009 最终发布门禁 | `NOT_READY` |

本次只新增本文件，未修改 RDP 实现、CI、UI 或测试代码，也没有用 mock 数据冒充真实性能 PASS。
