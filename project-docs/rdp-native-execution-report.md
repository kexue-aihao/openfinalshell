# 原生 RDP 编排执行报告

> 执行日期：2026-09-05
> 总编排角色：A0 agents-orchestrator
> 结论：`NOT_READY`，代码实现完成到 Windows x64 构建/契约验收阶段，发布与真实环境门禁未通过。

## 角色交付

| 角色 | 交付 | 结果 |
| --- | --- | --- |
| A1 项目管理 | 任务清单、依赖和外部阻塞 | 完成 |
| A2 ArchitectUX | profile、证书、MessagePort、错误状态和平台语义冻结 | 完成 |
| A3 Backend Architect | SessionManager、fallback、旧 Worker 隔离和帧契约审查 | 完成 |
| A4 Native | FreeRDP Worker、Unicode/IME 链路、dirty-region、矩形帧验证、CTest | 完成；真实服务器阻塞 |
| A5 Frontend | RDP profile UI、密码清除、locale 和 Renderer 测试 | 完成；真实 Electron 截图未验证 |
| A6 DevOps | Windows x64 构建、staging、package gate、CI 和 unsupported 矩阵 | Windows x64 通过；完整打包/签名阻塞 |
| A7 Legal | 依赖、许可证、SBOM、CVE 初审 | `BLOCKED_EXTERNAL_ENV / NOT_APPROVED` |
| A8 Performance | 背压行为基线和真实性能方案 | 行为通过；真实性能阻塞 |
| A9 EvidenceQA | 独立代理未在限定时间内产出 | A0 按同一清单完成等价 QA |
| A10 Reality Checker | 独立代理未在限定时间内产出 | A0 依据同一 P0 门禁完成最终现实检查 |
| A11 Mobile | Android 范围决策 | `OUT-OF-SCOPE`；schema 兼容保留 |

## 关键代码结果

- 生产帧路径固定为 MessagePort，帧 payload 为 `rdp-frame-v1` dirty rectangles；legacy `rdp:frame` 不再是生产依赖。
- Native Worker 已加入 Unicode scalar 校验、UTF-16 转换、scan-code/extended 回退、dirty-region 紧凑复制和尺寸/stride/64 MiB 限制。
- RDP profile 已支持 Domain、clipboard、证书 `prompt/strict`、旧字段保留和清除已保存密码。
- Worker build 默认要求 FreeRDP；Windows x64 HELLO 为 `freerdp`，unsupported 平台使用显式 absent marker。

## 发布阻塞

- 缺少授权真实 RDP 服务器、凭据注入、证书场景、IME 和故障注入条件。
- 缺少真实性能采集：1920x1080、30 FPS、60 秒、CPU、内存、IPC、输入 p95、GPU/Canvas 长稳。
- 缺少最终依赖逐文件许可证覆盖、SBOM 和固定数据源 CVE 扫描。
- 缺少 Windows Authenticode 证书/时间戳；macOS 公证条件也未提供。
- 本机完整 electron-builder 被 Visual Studio/node-gyp 依赖阻塞；需发布机复验。

详细 QA 与最终判定见 `rdp-native-evidence-qa.md` 和 `rdp-native-final-acceptance.md`。
