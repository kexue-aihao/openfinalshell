# RDP Native 最终现实验收

> 角色：A10 testing-reality-checker（A0 代行最终现实检查）
> 日期：2026-09-05
> 最终状态：`NOT_READY`

## 判定

当前实现已经达到“可构建、可进行契约测试的 Windows x64 FreeRDP 原型”，尚未达到“可发布的原生 RDP 软件”。最终状态不是 `READY`，也不是仅由未承诺平台造成的 `NEEDS_WORK`，因为多个 P0 发布门禁没有外部证据。

## P0 门禁

| 门禁 | 状态 | 现实检查结论 |
| --- | --- | --- |
| Windows x64 Worker 构建和 package gate | PASS | `workerVersion: freerdp`，含 `freerdp` capability，不含 `mock`；CTest `4/4` |
| 依赖、许可证、SBOM、CVE | BLOCKED_EXTERNAL_ENV / NOT_APPROVED | 依赖审计明确缺少最终逐文件 license 覆盖、SBOM 和 CVE 扫描 |
| Windows/macOS 签名与信任 | BLOCKED_EXTERNAL_ENV | Worker/App 当前为 `NotSigned`；证书、时间戳、公证凭据未提供 |
| 真实性能与长稳 | BLOCKED_EXTERNAL_ENV | 没有真实服务器、Electron/GPU harness 或 CPU/RSS/IPC/FPS/输入 p95 数据 |
| 真实 RDP 端到端 | BLOCKED_EXTERNAL_ENV | smoke 自动跳过；无成功认证、证书接受/拒绝、首帧、输入、resize、clipboard、重连证据 |
| Android 原生 RDP | OUT-OF-SCOPE | 本轮不声明 Android 原生 RDP，仅保留 schema/profile 兼容 |

## 已确认事实

- 定向 RDP 测试 `10 files passed, 63 tests passed`；全量 `npm test` 为 `108 files passed, 1566 tests passed`，另有既有跳过项。
- `npm run typecheck`、`npm run check:i18n`、`npm run build` 通过。
- Windows x64 FreeRDP Worker 构建、运行时 staging、package gate 和 CTest `4/4` 通过。
- unsupported 平台已通过显式 absent gate；没有将 mock Worker 当作生产原生 Worker。
- Android schema generation 通过，但 Android 单测因系统无 `gradle` 且仓库无 wrapper 未执行。

## 禁止发布的原因

RDP-007、RDP-008、RDP-009、RDP-010 均是本轮 P0 依赖。任一项失败或缺少证据都阻止 `READY`。当前至少同时缺少：真实 RDP/IME 环境、真实性能数据、SBOM/CVE 审计、签名/时间戳和完整发布机。

## 重新验收入口

在不把凭据写入命令行、仓库、日志或截图的前提下，补齐外部条件后重新执行：

```text
npm run smoke:rdp-worker -- build/rdp-worker/ofs-rdp-worker.exe
npm run package:dir
npm run check:rdp-worker -- --platform win --arch x64 --app-dir release/win-unpacked --require-freerdp
```

随后追加真实证据：accepted/rejected certificate、ready/first framebuffer、Unicode/IME、鼠标键盘、resize、clipboard、断线/重连、旧 Worker 隔离、60 秒性能和签名/SBOM/CVE 结果。没有这些结果前，保持 `NOT_READY`。
