# 跨平台 RDP 嵌入任务矩阵

> 文档状态：PM-01 基线（2026-09-03）
> 适用范围：Electron 桌面端；Android 不在本期实现。
> 本文冻结交付边界、依赖顺序、批次闸门和回滚点；具体帧字段与状态机以 ARCH-01 的架构契约为准。

## 1. 当前基线与冻结决策

### 1.1 已确认的代码事实

| 区域 | 当前行为 | 对本项目的影响 |
| --- | --- | --- |
| RDP 启动 | `src/main/services/rdpLaunch.ts` 生成不含密码的 `.rdp`，调用 `shell.openPath`；Windows 通常由 `mstsc.exe` 处理 | 现有路径不是嵌入式会话；保留为用户主动选择的降级路径 |
| 连接分派 | `src/renderer/src/stores/useSessionStore.ts` 的 `launchProfile` 对 `protocol: 'rdp'` 调 `conn:launchRdp`，不创建 tab | 新实现必须增加 `rdp` tab 和独立会话生命周期，不能复用 SSH `session:open` |
| IPC 契约 | `src/shared/ipc.ts` 只有 `conn:launchRdp`；事件流为 SSH `session:*`、`term:*` 等 | 需要新增 RDP 生命周期、帧、输入、resize 和剪贴板契约；继续通过 preload 白名单与 sender 校验 |
| 窗口安全 | `src/main/window.ts` 开启 `contextIsolation`、`sandbox`、`nodeIntegration: false`、`webSecurity`，并拒绝 `<webview>` | RDP 画面走 Canvas/WebGL + MessagePort；不得依赖 ActiveX、webview 或页面内 Node API |
| 数据模型 | `ConnectionProfile.protocol` 可为 `ssh`/`rdp`；RDP 注释说明系统客户端接管凭据，SSH 字段仍占位 | 扩展为可选 `profile.rdp` 配置时必须兼容旧记录；密码不能进入 renderer 持久状态、日志、命令行或 `.rdp` |
| 打包/依赖 | `electron-builder.yml` 已覆盖 Windows（x64/ia32/arm64）、macOS（x64/arm64/universal）、Linux（x64/arm64/armv7l）；当前运行时依赖无 FreeRDP | Worker 二进制需作为 `resources/rdp-worker` 按平台/架构打包，并建立许可证/动态库检查 |
| CI | `.github/workflows/ci.yml` 在 Windows 跑类型、i18n、全量测试并做 Linux 构建；`build-windows.yml` 在 Windows、macOS、Linux 做发布矩阵；Android 工作流独立 | 第一闭环先在 Windows x64；之后补 macOS/Linux，再补其他架构；Android 仅保持 schema/模型可解析 |

### 1.2 固定技术选择

- 协议引擎：C/C++ FreeRDP；不采用 ActiveX/COM、`mstsc` 窗口重挂或纯 JS/WASM 作为正式实现。
- 进程边界：每个 RDP 会话一个隐藏 Worker；Worker 不创建用户可见窗口，也不监听本地 TCP 端口。
- Worker 通信：stdin/stdout 双向流，统一 16 字节小端长度帧；单 payload 上限 64 MiB。控制消息为 UTF-8 JSON，画面为 BGRA8 脏矩形。
- Renderer 传输：main 到 renderer 使用 Electron `MessagePort` 与可转移 `ArrayBuffer`；WebGL2 优先，Canvas2D 回退；禁止每帧 PNG/base64 编解码。
- 凭据：密码由 main 侧一次性传给 Worker；可选通过现有 Vault 保存。不得写命令行、日志、配置或 `.rdp`。
- 降级：系统 RDP 客户端（Windows 上通常为 `mstsc`）只能由用户显式触发；Worker 缺失/启动失败不能静默打开外部窗口。
- 版本顺序：Windows x64 连接闭环 → macOS x64/arm64、Linux x64/arm64 → Windows ia32/arm64、Linux armv7l、macOS universal 验证。

## 2. 依赖与批次闸门

每批最多 6 个并行任务。只有该批全部开发任务及其独立 QA 任务为 PASS，下一批才可开始。QA 智能体不得修改被测实现；每项最多进行三轮开发/QA，第三轮仍失败则标记 BLOCKED 并升级。

```text
B1 范围/协议/Worker mock
 ├─ PM-01 → ARCH-01 → NATIVE-01
 └─ 每个开发任务分别由 QA-PM-01 / QA-ARCH-01 / QA-NATIVE-01 验证
                 ↓
B2 契约/FreeRDP/main/Vault（依赖 B1 PASS）
 ├─ CONTRACT-01 ─┐
 ├─ NATIVE-02 ───┼─→ MAIN-01 ─→（为 B3 提供稳定会话与帧通道）
 └─ CRED-01 ────┘
                 ↓
B3 renderer/输入/会话 UI（依赖 B2 PASS）
 ├─ RENDER-01 + INPUT-01 → SESSION-UI-01
                 ↓
B4 macOS/Linux/打包/测试基础设施（依赖 B3 PASS）
 ├─ NATIVE-03 ─┐
 ├─ BUILD-01 ──┼─→ TEST-INFRA-01
 └─（平台 QA）──┘
                 ↓
B5 文档/许可证/安全/最终回归（依赖 B4 PASS）
```

## 3. 分批任务矩阵

状态初始为 `PLANNED`；完成后由负责智能体报告 `DONE`、`BLOCKED` 或 `NEEDS-WORK`，并附修改文件、命令和结果。

### Batch 1：范围、协议与基础骨架（6）

| ID / 子智能体 | 交付物与边界 | 前置 | 独立 QA / 闸门 |
| --- | --- | --- | --- |
| **PM-01 / project-manager-senior** | 本文；冻结桌面平台矩阵、批次边界、回滚与非目标；不实现功能 | 无 | QA-PM-01：范围/依赖/Android 延后证据 |
| **ARCH-01 / ArchitectUX** | `project-docs/rdp-architecture.md`；冻结 16 字节头、控制/帧 payload、状态机、背压、凭据、证书、关闭与降级语义 | PM-01 | QA-ARCH-01：契约可直接实现且无待决选择 |
| **NATIVE-01 / Native C/C++ Engineer** | `native/rdp-worker` CMake 工程；stdin/stdout framed I/O、握手、长度/版本校验、错误退出、mock framebuffer/input；不接真实 FreeRDP | ARCH-01 | QA-NATIVE-01：mock 协议、畸形长度、截断、版本错、退出 |
| **QA-PM-01 / EvidenceQA** | 审核 PM-01 范围及依赖图，确认无 Android/设备重定向/外部窗口默认行为 | PM-01 | PASS 后 B1 范围闸门 |
| **QA-ARCH-01 / EvidenceQA** | 审核架构文档帧格式、背压、凭据和失败路径 | ARCH-01 | PASS 后 B1 协议闸门 |
| **QA-NATIVE-01 / API Tester** | 只测试 Worker mock，不改 Worker 实现 | NATIVE-01 | PASS 后 B1 基础闸门 |

### Batch 2：FreeRDP、主进程和凭据（6）

| ID / 子智能体 | 交付物与边界 | 前置 | 独立 QA / 闸门 |
| --- | --- | --- | --- |
| **CONTRACT-01 / Backend Architect** | 扩展 `src/shared`、preload、IPC：`rdp:*` 生命周期/输入/resize/剪贴板，`SessionTabKind='rdp'`、RDP 状态和可选 `profile.rdp`；旧 profile 可读 | B1 全部 PASS | QA-CONTRACT-01：schema、sender、旧 SSH 回归 |
| **NATIVE-02 / Native C/C++ Engineer** | 在 Worker 接入 FreeRDP，先交 Windows x64：TLS/NLA、证书回调、surface、键鼠、动态分辨率、基础 `cliprdr`；凭据只接受独立消息 | ARCH-01、NATIVE-01、CONTRACT-01 | QA-CORE-01：mock + Windows x64 连接/认证/断开 |
| **MAIN-01 / Backend Architect** | `RdpSessionManager` 与 main IPC；Worker 启停、背压、状态转发、MessagePort、关闭/重连、崩溃恢复、显式系统客户端降级 | CONTRACT-01、NATIVE-02 | QA-CORE-01：生命周期、异常、降级 |
| **CRED-01 / Security/Backend Engineer** | Vault 可选保存和 PromptHost 一次性密码/记住选择；全链路日志/参数脱敏 | CONTRACT-01 | QA-CORE-01：密码不落盘/不进命令行或日志 |
| **QA-CONTRACT-01 / API Tester** | 只验证新契约和兼容性 | CONTRACT-01 | PASS 后 B2 契约闸门 |
| **QA-CORE-01 / EvidenceQA** | 验证 Worker/main/Vault 的连接状态、证书错误、重连、降级；不修实现 | NATIVE-02、MAIN-01、CRED-01 | PASS 后 B2 核心闸门 |

### Batch 3：renderer 画面、输入和会话 UI（6）

| ID / 子智能体 | 交付物与边界 | 前置 | 独立 QA / 闸门 |
| --- | --- | --- | --- |
| **RENDER-01 / Frontend Developer** | `RdpPane`；WebGL2 BGRA 脏矩形、Canvas2D 回退、帧序列/尺寸适配、latest-wins 最多 2 帧 | B2 全部 PASS | QA-RENDER-01：合成帧、队列、截图 |
| **INPUT-01 / Frontend Developer** | 键盘扫描码、组合键、鼠标/滚轮、焦点捕获、resize 防抖、剪贴板；仅 typed preload IPC | RENDER-01、CONTRACT-01 | QA-INPUT-01：输入/失焦/关闭竞态和 SSH 隔离 |
| **SESSION-UI-01 / Frontend Developer** | store/tab/SessionView 接入 `rdp`；关闭/重连菜单；默认应用内 tab；Worker 不可用时显示显式系统客户端按钮 | MAIN-01、RENDER-01、INPUT-01 | QA-SESSION-UI-01：940x600、缩放、切换、无顶层窗口 |
| **QA-RENDER-01 / EvidenceQA** | 只测试 WebGL/Canvas 合成和帧队列 | RENDER-01 | PASS 后 B3 画面闸门 |
| **QA-INPUT-01 / API Tester** | 只测试输入控制器和 IPC 隔离 | INPUT-01 | PASS 后 B3 输入闸门 |
| **QA-SESSION-UI-01 / EvidenceQA** | 只测试会话 UI 与 SSH 回归 | SESSION-UI-01 | PASS 后 B3 UI 闸门 |

### Batch 4：三平台和发布集成（6）

| ID / 子智能体 | 交付物与边界 | 前置 | 独立 QA / 闸门 |
| --- | --- | --- | --- |
| **NATIVE-03 / Native C/C++ Engineer** | FreeRDP Worker 移植 macOS x64/arm64、Linux x64/arm64；统一 CMake/能力探测；v1 禁止非核心设备重定向 | B3 全部 PASS、NATIVE-02 | QA-NATIVE-03：各平台 CTest/启停/协议一致性 |
| **BUILD-01 / DevOps Automator** | electron-builder/Actions 将 Worker 放入 `resources/rdp-worker`；覆盖 Windows x64/ia32/arm64、macOS x64/arm64/universal、Linux x64/arm64/armv7l 检查 | NATIVE-03 | QA-BUILD-01：asar、路径、打包和无 Worker 降级 |
| **TEST-INFRA-01 / Test Infrastructure Engineer** | mock Worker、协议回归、renderer 合成帧、main 生命周期、可选真实 RDP 测试；凭据仅环境变量，缺服务器时跳过 | B3、NATIVE-03 | QA-TEST-INFRA-01：完整可重复测试矩阵 |
| **QA-NATIVE-03 / API Tester** | 在 macOS/Linux runner 执行原生构建与协议测试，记录能力缺口 | NATIVE-03 | PASS 后 B4 原生闸门 |
| **QA-BUILD-01 / DevOps QA** | 验证现有 build/package 与 Worker 打包路径 | BUILD-01 | PASS 后 B4 发布闸门 |
| **QA-TEST-INFRA-01 / EvidenceQA** | 执行测试基础设施和 SSH 回归，不改实现 | TEST-INFRA-01 | PASS 后 B4 测试闸门 |

### Batch 5：文档、安全审计与最终集成（5）

| ID / 子智能体 | 交付物与边界 | 前置 | 独立 QA / 闸门 |
| --- | --- | --- | --- |
| **DOC-01 / Technical Writer** | README、设置页、多语言：嵌入式 RDP、凭据、平台限制、显式降级、未支持重定向；移除“项目不提供 RDP”过时描述 | B4 全部 PASS | QA-DOC-01：i18n 键与 `npm run check:i18n` |
| **SEC-AUDIT-01 / Legal Compliance Checker** | FreeRDP/OpenSSL/编解码许可证、动态库通知、凭据生命周期、证书策略、剪贴板边界、日志脱敏审计；列出必须修复项 | B4 全部 PASS | QA-SEC-AUDIT-01：静态/运行时安全验证 |
| **QA-DOC-01 / EvidenceQA** | 文案与翻译一致性，不改功能 | DOC-01 | PASS 后文档闸门 |
| **QA-SEC-AUDIT-01 / Security QA** | 证明密码不在命令行、日志、IPC 错误、renderer 持久状态 | SEC-AUDIT-01 | PASS 后安全闸门 |
| **FINAL-01 / testing-reality-checker** | 运行 `npm run typecheck`、`npm test`、`npm run build`、CTest、打包冒烟、UI 截图；确认默认无外部窗口且 SSH 无回归 | B5 所有 QA PASS | 全部通过才 `READY`，否则 `NEEDS-WORK` |

## 4. 回滚与发布策略

### 4.1 可回滚单元

1. **Feature flag / capability gate**：RDP 嵌入默认只在 Worker、协议版本和 renderer 能力检查全部通过时启用；否则连接页只显示“使用系统远程桌面”按钮。该门禁必须由 main 判定，不能由 renderer 自行绕过。
2. **按层回滚**：Worker、main manager、IPC 契约、renderer UI、打包资源分别可独立回退；SSH `session:*`、`term:*` 及旧 `conn:launchRdp` 路径保持可编译、可测试。
3. **发布回滚**：若任一平台的 Worker 崩溃率、连接失败率、帧延迟或凭据泄露检查不达标，停止该平台/架构发布，保留已验证平台；必要时将默认行为切回显式系统客户端，不删除旧 profile 字段。
4. **数据回滚**：`profile.rdp`、Vault 引用和 tab 持久化字段采用可选/向后兼容读取；回滚版本遇到新字段必须忽略而不是删除。密码不写 `.rdp`，因此无需清理旧明文文件；临时 Worker socket/缓存退出时删除。
5. **原生资源回滚**：electron-builder 中 Worker 资源可按版本移除；启动失败必须记录脱敏错误并给出降级按钮，不能阻止 SSH 启动。发布产物需保留各架构独立 artifact，禁止用错误架构 Worker 静默替代。

### 4.2 批次放行检查

- B1：架构文档与 mock Worker 协议测试 PASS。
- B2：Windows x64 真实 FreeRDP 连接至少覆盖认证、证书拒绝、断开、重连和密码不落盘。
- B3：合成 1920x1080、30 FPS 帧流运行 60 秒，队列不超过 2 帧且内存稳定；最小窗口 940x600 无额外顶层窗口。
- B4：macOS/Linux 构建与打包路径通过；无真实 RDP 服务器时 CI 使用 mock，不因缺环境失败。
- B5：类型、单元/集成、原生 CTest、i18n、打包冒烟和安全审计全部 PASS。

## 5. 非目标与延期

- Android 本期不增加 RDP UI、JNI 或 native 引擎；只要求共享 schema/模型继续可解析 `protocol: 'rdp'`。
- v1 不实现服务端、音频、打印机、磁盘、摄像头、智能卡、USB、设备重定向、多显示器和长期证书信任库。
- 不把 `mstsc`/ActiveX 窗口重挂到 Electron，不开放本地 TCP 网关，不引入 Guacamole/`guacd`。
- 不改 SSH 会话协议、终端渲染、SFTP、监控和端口转发语义；相关回归是每批 QA 和 FINAL-01 的硬闸门。
- 不在本任务中承诺自动更新签名、FreeRDP 上游功能开发或服务端部署；许可证/动态库合规必须在发布前由 SEC-AUDIT-01 关闭。

## 6. PM-01 验证记录

- 已读取：`src/main/services/rdpLaunch.ts`、`src/main/window.ts`、`src/shared/ipc.ts`、`src/shared/types.ts`、`src/main/ipc/conn.ipc.ts`、`src/main/ipc/session.ipc.ts`、`src/renderer/src/stores/useSessionStore.ts`、`electron-builder.yml`、`package.json`、`.github/workflows/ci.yml`、`.github/workflows/build-windows.yml` 及 Android 工作流。
- `git status --short` 在本任务开始时仅显示既有未跟踪 `.claude/`；未修改或删除该目录及其他用户文件。
- 本任务仅新增本文件；未运行会改写仓库文件的命令，未实现任何 RDP 功能代码。
