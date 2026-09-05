# RDP Native EvidenceQA 记录

> 任务：RDP-002 至 RDP-011 QA 复核
> 执行角色：A0（A9 EvidenceQA 代理未在限定时间内产出文件，由 A0 按同一门禁执行等价复核）
> 日期：2026-09-05

## 1. 结论

代码、契约和 Windows x64 Worker 构建证据通过；真实服务器、真实性能、发布合规和签名证据不足。QA 结论为 `PARTIAL / NOT_READY`，不能把当前工作区声明为生产就绪。

## 2. 命令证据

以下命令在 `E:\openfinalshell` 执行，未把密码或完整凭据写入日志：

| 命令 | 结果 |
| --- | --- |
| `npm test` | PASS：108 个文件，1566 个测试；5 个文件、37 个测试按既有条件跳过 |
| `npm test -- --run test/unit/rdpContract.test.ts ... test/renderer/rdpProfileForm.test.ts` | PASS：10 个文件，63 个测试 |
| `npm run typecheck` | PASS：node 与 web 均通过 |
| `npm run check:i18n` | PASS：10 种语言 |
| `npm run build` | PASS：Electron Vite 三端构建完成 |
| `npm run build:rdp-worker -- --platform win --arch x64 --require-freerdp` | PASS：FreeRDP 3.30.0；Worker 自测与 CTest 执行 |
| `npm run check:rdp-worker -- --platform win --arch x64 --require-freerdp` | PASS：`build/rdp-worker/ofs-rdp-worker.exe` |
| `ctest --test-dir build/rdp-worker-cmake/win-x64 --output-on-failure` | PASS：`4/4`，含 hello、Unicode、frame validation、protocol |
| `npm run smoke:rdp-worker -- build/rdp-worker/ofs-rdp-worker.exe` | BLOCKED_EXTERNAL_ENV：缺少 `OFS_TEST_RDP_HOST`、`OFS_TEST_RDP_USERNAME`、`OFS_TEST_RDP_PASSWORD`，脚本跳过真实 smoke |
| `npm run android:generate-schema` | PASS |
| `npm run android:test` | BLOCKED_EXTERNAL_ENV：系统无 `gradle`，仓库无 Gradle wrapper |

平台 unsupported gate 已串行执行并通过：Windows ARM64、macOS x64/arm64、Linux x64/arm64 均为显式 `--package-disabled` + `--expect-absent`。并行执行会竞争同一个 staging 目录，曾出现一次 `EPERM`；串行重跑全部通过，该竞态不计为产品失败。

## 3. 任务判定

| 任务 | 判定 | 证据与限制 |
| --- | --- | --- |
| RDP-002 | PASS | 架构/契约文档、profile、MessagePort、错误码和 fallback 前置条件已冻结；定向测试和 typecheck 通过 |
| RDP-003 | QA（自动化通过） | Domain、clipboard、证书策略、旧 profile 保留、清除密码和 locale 已覆盖；真实 Electron 截图未执行 |
| RDP-004 | BLOCKED_EXTERNAL_ENV | Native Unicode/扫描码/extended/dirty-region 代码和 CTest 通过；真实 Windows IME 与授权服务器未提供 |
| RDP-005 | BLOCKED_EXTERNAL_ENV | rect-only `rdp-frame-v1`、64 MiB/stride/尺寸校验、ACK/backpressure 和旧代隔离通过；真实 1920x1080/高分辨率帧流未测量 |
| RDP-006 | BLOCKED_EXTERNAL_ENV（Worker gate通过） | FreeRDP Worker、运行库、manifest、NOTICE、self-test、package gate、CTest 通过；完整 electron-builder 因缺少 Visual Studio 被阻塞 |
| RDP-007 | BLOCKED_EXTERNAL_ENV / NOT_APPROVED | 没有 SPDX/CycloneDX SBOM、固定 CVE 数据源/扫描结果和最终依赖逐文件合规签核 |
| RDP-008 | BLOCKED_EXTERNAL_ENV | App/Worker Authenticode 为 `NotSigned`；无签名证书、时间戳、公证或干净机证据 |
| RDP-009 | BLOCKED_EXTERNAL_ENV | 仅有 fake endpoint 背压行为测试；CPU、RSS、IPC、FPS、输入 p95、GPU/Canvas 长稳未采集 |
| RDP-010 | BLOCKED_EXTERNAL_ENV | 真实 smoke 因缺少授权 RDP 服务器、账号、证书场景和故障注入条件而跳过 |
| RDP-011 | OUT-OF-SCOPE | 本轮不实现 Android 原生 RDP；仅保留 profile/schema 兼容边界 |

## 4. 实现覆盖

- `RdpSessionManager`、shared frame parser、preload validator 和 Renderer 已统一为生产 MessagePort + dirty rectangle 契约；`rdp:frame` 仅保留兼容/测试接口。
- Native Worker 使用 FreeRDP dirty region、BGRA8 紧凑矩形、Unicode UTF-16（含补充平面代理项）和扫描码回退。
- profile UI 已支持 Domain、clipboard、证书策略和清除已存密码，locale 检查通过。
- Worker 构建默认要求真实 FreeRDP；unsupported 平台显式不 staging Worker，不用 mock 冒充生产能力。

## 5. 未完成的放行前置条件

1. 提供授权 Windows RDP 测试服务器、测试账号、可控证书接受/拒绝场景和可注入断线/重连环境。
2. 在真实 Electron/GPU 环境完成 1920x1080、30 FPS、60 秒和高分辨率/resize/input/clipboard 长稳采集。
3. 生成与最终 artifact digest 绑定的逐文件依赖清单、SPDX/CycloneDX SBOM 和固定数据源 CVE 扫描。
4. 提供 Windows 签名证书、时间戳服务和干净环境验证；启用 macOS 前另行完成 codesign/notarization。
5. 在带 Visual Studio 的发布机完成完整 electron-builder 产物并再次运行 app-dir package gate。
