# 原生 RDP 可执行任务清单

> 阶段：1（A1 项目管理任务化）
> 生成日期：2026-09-05
> 输入：`project-docs/rdp-native-worker-audit.md`、`project-docs/rdp-native-orchestration-plan.md`、当前仓库 RDP 文件与测试状态

## 1. 当前基线

- Windows x64 的 FreeRDP Worker、main 会话管理、RDP IPC、preload MessagePort、Renderer Canvas 和会话 Tab 已接通。
- RDP 定向测试当前结果为 `10 files passed, 63 tests passed`；全量回归为 `108 files passed, 1566 tests passed, 5 skipped`。
- 仓库已有 `build/rdp-worker` staging 目录，包含 `ofs-rdp-worker.exe`、FreeRDP/WinPR DLL、runtime manifest 和第三方声明；该产物仍必须由最终 package gate 和发布环境再次确认。
- `build/rdp-worker-direct/ofs-rdp-worker.exe` 的自检显示 `workerVersion: mock`，不能作为生产 FreeRDP 证据；最终验收只能使用 `workerVersion: freerdp` 且含 `freerdp` capability 的产物。
- macOS、Linux、Windows ARM64 当前仍通过 `--package-disabled` / `--expect-absent` 表达“不提供原生 Worker”，不能宣称嵌入式 RDP 已支持。
- 当前工作区存在用户已有的未提交修改和未跟踪 RDP 文件。本清单不改变、不覆盖、不清理这些内容。
- v1 非目标：音频、打印机、磁盘、摄像头、智能卡、USB、设备重定向、多显示器、RD Gateway 和长期证书信任库；这些能力不作为本轮完成条件。

## 2. 执行规则

- 任务状态：`PASS`、`TODO`、`IN_PROGRESS`、`QA`、`FAIL_RETRY`、`BLOCKED`、`BLOCKED_EXTERNAL_ENV`。
- 只有 `PASS` 可以满足后续依赖。外部条件缺失时必须标记 `BLOCKED_EXTERNAL_ENV`，不得通过降低测试标准放行。
- 每个任务只有一个唯一负责人；协作角色只能提供输入或审查，不能替代负责人交付。
- RDP-003 至 RDP-011 的实现任务最多进行三轮“负责人修改 → A9 QA”；第三轮仍失败时升级 A0。QA 自身最多重试两次。
- 所有凭据只能由执行环境通过环境变量注入。密码不得进入命令行参数、仓库、截图、普通日志或 Renderer 持久状态。
- 每次交接必须记录修改文件、未修改的相关文件、测试命令及结果、日志/截图证据、限制和下一位负责人。

## 3. 任务总表

| ID | 优先级 | 唯一负责人 | 依赖 | 当前状态 | 适用条件 |
| --- | --- | --- | --- | --- | --- |
| RDP-001 | P0 | A1 `project-manager-senior` | 无 | PASS（本清单交付） | 全部 RDP 范围 |
| RDP-002 | P0 | A2 `ArchitectUX` | RDP-001 | PASS | 全部桌面端 RDP |
| RDP-003 | P1 | A5 `Frontend Developer` | RDP-002 | QA（自动化通过；视觉截图未验证） | 需要可配置的嵌入式 RDP profile |
| RDP-004 | P1 | A4 `engineering-senior-developer (Native)` | RDP-002 | BLOCKED_EXTERNAL_ENV（代码/CTest通过） | Windows x64 v1；其他平台启用时同样适用 |
| RDP-005 | P1 | A4 `engineering-senior-developer (Native)` | RDP-002 | BLOCKED_EXTERNAL_ENV（契约/CTest通过） | 使用真实帧流的嵌入式 RDP |
| RDP-006 | P0/P1 | A6 `DevOps Automator` | RDP-002 | BLOCKED_EXTERNAL_ENV（Worker gate通过；完整 App 打包阻塞） | Windows x64 发布必做；其他平台为条件任务 |
| RDP-007 | P0 | A7 `Legal Compliance Checker` | RDP-006（最终签核） | BLOCKED_EXTERNAL_ENV | 任何包含原生 Worker 的发布包 |
| RDP-008 | P0 | A6 `DevOps Automator` | RDP-006、RDP-007 | BLOCKED_EXTERNAL_ENV | 声称可发布的平台；Windows/macOS 签名分别适用 |
| RDP-009 | P0 | A8 `Performance Benchmarker` | RDP-003、004、005、006 | BLOCKED_EXTERNAL_ENV | 生产就绪声明或性能承诺 |
| RDP-010 | P0 | A10 `testing-reality-checker` | RDP-003 至 RDP-009 的相关任务 | BLOCKED_EXTERNAL_ENV | 真实 RDP 端到端验收；Windows x64 首要门禁 |
| RDP-011 | P1（条件） | A11 `Mobile App Builder` | RDP-001 | OUT-OF-SCOPE | 仅当产品将 Android 原生 RDP 纳入本轮 |

## 4. 详细任务

### RDP-001：范围、基线和任务清单

- 优先级：P0。
- 唯一负责人：A1 `project-manager-senior`；A0 负责复核，不替代交付。
- 依赖：无。
- 适用条件：全部桌面端 RDP 工作，无论最终支持哪些平台。
- 修改范围：仅新增 `project-tasks/rdp-native-tasklist.md`；读取审计、编排计划、RDP 源码/测试和工作区状态。不得修改源代码、CI 或既有文档。
- 测试命令：`git status --short`；`rg --files | rg "rdp|Rdp|freerdp|FreeRdp"`；`npm test -- --run test/unit/rdpContract.test.ts test/unit/rdpProfileContract.test.ts test/unit/rdpSessionManager.test.ts test/unit/rdpShutdownContract.test.ts test/unit/rdpWorkerPackageGate.test.ts test/unit/rdpWorkerSmoke.test.ts test/renderer/rdpWiring.test.ts test/renderer/rdpInput.test.tsx test/renderer/rdpFrameComposition.test.ts test/renderer/rdpPackaging.test.ts`。
- 验收标准：RDP-001 至 RDP-011 每项都有唯一 ID、优先级、依赖、唯一负责人、范围、测试命令、验收标准和外部阻塞；已实现、待实现、条件任务和 v1 非目标不混淆；基线 dirty 状态被记录。
- 外部阻塞：无。A0 若发现审计版本或产品范围冲突，必须在派发 RDP-002 前解决。

### RDP-002：架构、契约和 UX 冻结

- 优先级：P0。
- 唯一负责人：A2 `ArchitectUX`；A3 提供 main/IPC 审查意见。
- 依赖：RDP-001 PASS。
- 适用条件：全部桌面端嵌入式 RDP；不适用于仅保留系统客户端降级的旧路径。
- 修改范围：`project-docs/rdp-native-architecture.md`（若与既有 `project-docs/rdp-architecture.md` 重叠，先由 A0 决定归档/合并边界）；RDP profile 字段、敏感字段生命周期、证书 `prompt`/`strict`、clipboard、Worker/main/preload/renderer 消息契约、重连和旧 Worker 隔离、平台降级语义。不得直接实现功能代码。
- 测试命令：`npm test -- --run test/unit/rdpContract.test.ts test/unit/rdpProfileContract.test.ts test/unit/rdpSessionManager.test.ts test/unit/preloadContract.test.ts`；`npm run typecheck`。
- 验收标准：架构文档逐项映射现有文件和后续实现任务；旧 profile 可读且新增字段可选；密码不进入 argv、日志或普通 Renderer 状态；所有错误、证书和 Worker 缺失状态都有用户可见结果；无未决协议选择即可派发 RDP-003 至 RDP-006。
- 外部阻塞：若产品尚未决定非 Windows 平台能力声明或证书默认策略，A0 必须冻结决策；无需真实服务器即可完成文档和契约验收。

### RDP-003：RDP 配置编辑与持久化

- 优先级：P1。
- 唯一负责人：A5 `Frontend Developer`；A2/A3 仅协作审查。
- 依赖：RDP-002 PASS。
- 适用条件：提供应用内 RDP profile 编辑和保存的桌面端。
- 修改范围：`src/renderer/src/features/connections/ProfileEditDrawer.tsx`、连接模型/store、RDP 相关 locale 和对应 Renderer/unit 测试。必须覆盖 Domain、clipboard 开关、证书策略、已有 profile 字段保留、清除已保存密码、旧配置兼容、表单校验和国际化；不修改 Native Worker 协议实现。
- 测试命令：`npm test -- --run test/unit/rdpProfileContract.test.ts test/renderer/rdpWiring.test.ts test/renderer/sessionStore.test.ts`；`npm run check:i18n`；`npm run typecheck`。
- 验收标准：新增、编辑、取消、保存、清除密码五条流程均有自动化覆盖；编辑不会硬编码覆盖 clipboard/certificate policy/domain；密码不回显到普通日志或非敏感状态；UI 截图中控件、校验错误和窄窗口布局无重叠。
- 外部阻塞：无代码外部阻塞；若 Vault 的保存/清除语义或证书默认值需要产品/安全确认，必须在 RDP-002 冻结后再实现，不能自行改变既有凭据策略。

### RDP-004：Unicode、键盘布局和 IME 输入

- 优先级：P1。
- 唯一负责人：A4 `engineering-senior-developer (Native)`；A5 只负责 Renderer 输入事件协作。
- 依赖：RDP-002 PASS。
- 适用条件：Windows x64 v1 必须完成；每个后续启用原生 Worker 的平台都必须复验。
- 修改范围：`native/rdp-worker/freerdp_adapter.cpp`、必要的 native 输入契约/测试，以及 `src/renderer/src/features/sessions/RdpPane.tsx` 和 preload 输入边界。贯通扫描码、扩展键、Unicode、组合键、死键和至少一套 IME 场景；不得绕过 Worker 在 Renderer 直接连接 RDP。
- 测试命令：`npm test -- --run test/renderer/rdpInput.test.tsx test/unit/rdpContract.test.ts`；`cmake --build <worker-build-dir> --config Release --parallel`；`ctest --test-dir <worker-build-dir> -C Release --output-on-failure`；在具备 IME 的 Windows 环境运行真实 smoke：`npm run smoke:rdp-worker -- build/rdp-worker/ofs-rdp-worker.exe`。
- 验收标准：中英文及日文或韩文输入可重复验证；Unicode 字段从 Renderer 到 FreeRDP Unicode API 有契约证据；扫描码/扩展键/组合键行为不回归；输入失败能回报错误或安全结束，不得静默吞掉。
- 外部阻塞：真实 IME 需要 Windows IME、可登录的授权 RDP 服务器和测试账号；缺少时只能完成 mock/契约测试，并标记真实验收为 `BLOCKED_EXTERNAL_ENV`。

### RDP-005：帧传输、校验和稳定性

- 优先级：P1。
- 唯一负责人：A4 `engineering-senior-developer (Native)`；A3 审查 main 边界，A8 提供测量要求。
- 依赖：RDP-002 PASS；RDP-004 可并行，但联合验收须同时覆盖。
- 适用条件：所有使用嵌入式 Canvas/WebGL 帧流的 RDP Worker。
- 修改范围：`native/rdp-worker/freerdp_adapter.cpp`、`src/main/rdp/RdpSessionManager.ts`、Renderer 帧合成/测试边界中必要的校验代码。核对 dirty-region，减少整屏复制，统一宽高/stride/payload/像素上限校验，评估 stdout `Buffer.concat`，保持 ACK、背压、超时和 latest-wins 语义。
- 测试命令：`npm test -- --run test/renderer/rdpFrameComposition.test.ts test/unit/rdpSessionManager.test.ts test/unit/rdpShutdownContract.test.ts`；`ctest --test-dir <worker-build-dir> -C Release --output-on-failure`；`npm run smoke:rdp-worker -- build/rdp-worker/ofs-rdp-worker.exe`；新增的压力/基准命令由 A8 在 RDP-009 中固定并记录。
- 验收标准：1920x1080 及至少一个更高分辨率场景有 CPU、内存、IPC payload、帧率和丢帧数据；损坏尺寸、超 stride、超 64 MiB 和连续压力帧被拒绝或降级；旧 Worker/旧 MessagePort 事件不能污染新会话；队列上限和 ACK 超时行为可复现。
- 外部阻塞：高分辨率/真实帧流测量需要授权 RDP 服务器、目标 Electron/GPU 环境和可重复的压力场景；缺少时不得宣称稳定性达标。

### RDP-006：Worker 开发、构建和平台矩阵

- 优先级：P0（Windows x64）；P1（其他平台条件支持）。
- 唯一负责人：A6 `DevOps Automator`；A4 协作原生编译问题。
- 依赖：RDP-002 PASS；各平台实现需等待 RDP-004/RDP-005 的适用部分。
- 适用条件：Windows x64 是本轮发布必做；macOS x64/arm64、Linux x64/arm64、Windows ARM64/ia32、Linux armv7l 只有在项目决定启用时才转为必做，否则必须形成明确 unsupported 证据。
- 修改范围：`scripts/buildRdpWorker.mjs`、`scripts/checkRdpWorkerPackage.mjs`、`electron-builder.yml`、相关 `.github/workflows/*`、本地开发 Worker 自动发现和资源 staging。不得将 mock Worker 打包成生产 RDP 能力。
- 测试命令：Windows x64：`npm run build:rdp-worker -- --platform win --arch x64 --require-freerdp`、`npm run check:rdp-worker -- --platform win --arch x64 --require-freerdp`、`ctest --test-dir <worker-build-dir> --output-on-failure`；禁用目标：`npm run build:rdp-worker -- --platform <platform> --arch <arch> --package-disabled`、`npm run check:rdp-worker -- --platform <platform> --arch <arch> --expect-absent`；应用回归：`npm run typecheck && npm run build`。
- 验收标准：每个目标有构建日志、架构正确性、运行时 DLL/库清单、启动自测和 package gate；已支持目标自检为 `workerVersion: freerdp` 且不含 `mock`；未支持目标 staging 和解包目录均无 Worker；`npm run dev` 能找到开发 Worker 或给出明确诊断/显式降级。
- 外部阻塞：macOS/Linux/ARM64 需要对应 runner、FreeRDP SDK/编译器、运行时依赖和交叉工具链；没有这些条件时只能保持 disabled，不能将环境缺失伪装为完成。

### RDP-007：许可证、SBOM、CVE 与原生发布安全

- 优先级：P0。
- 唯一负责人：A7 `Legal Compliance Checker`；A6 提供最终构建产物和依赖来源。
- 依赖：RDP-006 的最终依赖清单；初步合规策略可提前开始。
- 适用条件：任何包含 FreeRDP Worker 或其动态依赖的发布包；系统 RDP 降级包不替代原生依赖审计。
- 修改范围：原生 Worker staging/发布目录中的第三方声明、许可证清单、SBOM、CVE 审计记录和发布门禁配置；核对 FreeRDP、WinPR、OpenSSL、zlib、图像/编解码库及全部传递依赖的实际版本和来源。不得只依据构建机上“存在某个 LICENSE 文件”放行。
- 测试命令：`npm run build:rdp-worker -- --platform win --arch x64 --require-freerdp`；`npm run check:rdp-worker -- --platform win --arch x64 --require-freerdp`；对最终 stage/app artifact 执行团队批准的 SBOM 工具和 CVE 数据库扫描；逐项核对 `rdp-worker-runtime.json`、`THIRD-PARTY-NOTICES.rdp-worker.txt` 与实际 DLL。
- 验收标准：许可证清单来自最终分发物中的实际二进制及版本；SBOM 可追溯组件版本、来源和许可证；高危漏洞有修复、排除或正式例外审批；缺失许可证、SBOM 或不可接受漏洞会阻断 package/release job；Electron 资源与 Worker 完整性可验证。
- 外部阻塞：需要最终锁定的依赖版本、许可证/源码归属要求、漏洞扫描服务或固定离线数据库，以及合规审批人；这些条件缺失时状态为 `BLOCKED_EXTERNAL_ENV`。

### RDP-008：代码签名、公证和平台信任

- 优先级：P0。
- 唯一负责人：A6 `DevOps Automator`；A7 做安全/合规复核。
- 依赖：RDP-006 PASS、RDP-007 PASS。
- 适用条件：每个声称可发布的平台；Windows 重点验证 App 和 Worker，macOS 还必须验证嵌套动态库、公证和 stapling；未启用的平台不以签名任务替代平台支持证据。
- 修改范围：发布 workflow、签名/公证配置、Worker 和 Electron 资源的签名范围与篡改检测；不得把签名密钥、notarization secret 或密码写入仓库和日志。
- 测试命令：Windows：`Get-AuthenticodeSignature <app-or-worker>`、`signtool verify /pa <app-or-worker>`；macOS：`codesign --verify --deep --strict --verbose=2 <app>`、`spctl --assess --type execute <app>`、`xcrun stapler validate <app>`；在干净环境安装启动并执行 package smoke。
- 验收标准：目标产物签名链、时间戳、entitlements 和公证状态均有成功日志；篡改 Worker 后安装/启动或门禁能检测；签名失败会阻断 release job；干净 Windows/macOS 环境启动不因 SmartScreen/Gatekeeper 产生未解释阻塞。
- 外部阻塞：需要有效 Windows 代码签名证书、Apple Developer/notarization 凭据、CI secrets、对应干净验证机和网络服务；凭据未提供时不得报告发布安全 PASS。

### RDP-009：真实性能与长稳测试

- 优先级：P0。
- 唯一负责人：A8 `Performance Benchmarker`；A4/A3 协作提供观测点，A9 只复核证据。
- 依赖：RDP-003、RDP-004、RDP-005、RDP-006 相关部分 PASS。
- 适用条件：所有要作“生产就绪”或明确性能承诺的目标平台；仅保留系统客户端降级的平台不执行嵌入式帧基准。
- 修改范围：性能测试脚本、原始日志/指标格式、性能报告和回归阈值；必要时由 A4/A3/A5 提供埋点，但 A8 不修改业务实现来掩盖指标。
- 测试命令：`npm run smoke:rdp-worker -- build/rdp-worker/ofs-rdp-worker.exe`；在 A8 交付的基准脚本中执行 1920x1080、30 FPS、至少 60 秒连接、缩放/动态分辨率、持续输入、clipboard、网络抖动、断开/重连和 GPU/Canvas context loss 场景；全量回归：`npm test && npm run typecheck && npm run build`。
- 验收标准：报告首帧时间、稳定帧率、丢帧率、CPU、内存增长、IPC 吞吐、输入 p95 延迟和断线恢复时间；A8 与 A0 预先签署阈值；原始日志可复现；任一阈值不达标必须产生优化任务并标记 `NEEDS-WORK`，不能改写结论。
- 外部阻塞：需要授权 RDP 服务器、稳定和抖动网络场景、目标 Electron/GPU 设备、可用输入/clipboard 测试账号和足够长的运行窗口。

### RDP-010：真实 RDP 服务器端到端验收

- 优先级：P0。
- 唯一负责人：A10 `testing-reality-checker`；A9 执行并提交可复现证据，A10 保留最终判定权。
- 依赖：RDP-003 至 RDP-009 中相关任务均 PASS；必须使用 RDP-006 产出的最终 FreeRDP Worker 和应用包。
- 适用条件：任何声称嵌入式 RDP 可用/可发布的目标平台；Windows x64 是第一验收目标。
- 修改范围：仅测试记录、验收报告、日志和截图证据；A10/A9 不修改被测实现。测试包括成功认证、错误密码、Domain、证书接受/拒绝、首帧、扫描码/Unicode、鼠标/按钮/滚轮、动态分辨率、clipboard、服务端断开、客户端关闭、应用级重连、Worker 替换和旧事件隔离。
- 测试命令：环境变量由执行环境注入后运行 `npm run smoke:rdp-worker -- build/rdp-worker/ofs-rdp-worker.exe`；必要时运行 `npm run smoke:packaged`、`npm test -- --run test/integration/reconnect.test.ts test/unit/rdpSessionManager.test.ts test/unit/rdpShutdownContract.test.ts`；不得在命令行或日志中展开密码。
- 验收标准：accepted 与 rejected certificate 场景均有明确 PASS/FAIL；真实服务器达到 ready 和 first framebuffer；输入、resize、clipboard、断开、重连和关闭都有日志/截图或协议证据；最终包而非 mock/development-only Worker 通过；任一 P0 失败则最终状态不是 `READY`。
- 外部阻塞：必须提供授权的 Windows RDP 测试服务器、端口、账号/Domain、可控证书场景、服务端断开/网络故障条件和安全凭据注入；缺少这些条件直接标记 `BLOCKED_EXTERNAL_ENV`，不能以 mock 测试替代真实验收。

### RDP-011：Android 范围决策

- 优先级：P1（条件任务）。
- 唯一负责人：A11 `Mobile App Builder`；A1/A0 负责产品范围复核。
- 依赖：RDP-001 PASS；不阻塞 Windows x64 发布，但必须出现在最终报告中。
- 适用条件：仅当产品明确把 Android 原生 RDP 纳入本轮范围时进入实现；否则执行 OUT-OF-SCOPE 决策，不实现 JNI、RDP UI 或 Android Native 引擎。
- 修改范围：Android schema/model 兼容性测试、Android 范围决策文档或独立实施方案；若 IN-SCOPE，另行冻结 FreeRDP/Android UI、输入法、证书、clipboard、网络生命周期和打包边界。不得把 profile 可解析误报为 Android RDP 已支持。
- 测试命令：OUT-OF-SCOPE：`npm run android:generate-schema`、`npm run android:test`；IN-SCOPE 还必须加入 Android 单元/UI/Native 集成测试和真实服务器 smoke，并由 A0 批准新增命令。
- 验收标准：明确记录 `IN-SCOPE` 或 `OUT-OF-SCOPE`、理由、版本目标和测试边界；OUT-OF-SCOPE 时现有 `protocol: 'rdp'` schema 兼容测试通过且产品文案不暗示 Android 已具备 RDP；IN-SCOPE 时需另有平台构建、输入、证书、clipboard、真实服务器和发布包证据。
- 外部阻塞：IN-SCOPE 需要产品决定、Android NDK/FreeRDP 方案、JNI/构建环境、测试设备和授权 RDP 服务器；在决定或环境缺失时保持条件任务，不阻塞桌面端。

## 5. 阶段门禁与执行顺序

1. 阶段 1：本清单（RDP-001）由 A0 复核后，派发 RDP-002。
2. 阶段 2：RDP-002 PASS 后，A2/A3 冻结契约；未冻结前不得进入并行实现。
3. 阶段 3：RDP-003、RDP-004、RDP-005、RDP-006 和 RDP-007 按文件边界并行推进；同一契约或文件冲突由 A0 排队。RDP-008 等待 RDP-006/007，RDP-009 等待功能与 Worker 基线。
4. 阶段 4：RDP-009 完成并得到证据后，使用最终打包产物执行 RDP-010。真实服务器缺失时阶段状态只能为 `BLOCKED_EXTERNAL_ENV`。
5. 阶段 5：A7 完成最终合规签核、A6 完成签名/公证、A10 完成现实检查后，A0 才能给出 `READY`、`NEEDS_WORK` 或 `NOT_READY`。

## 6. 阶段 1 自检

- 任务数量：11，覆盖 RDP-001 至 RDP-011，无重复或缺失。
- 每项均包含：优先级、依赖、唯一负责人、修改范围、测试命令、验收标准、外部阻塞和适用条件。
- 已将 Windows x64 必做、其他平台条件支持、Android 条件决策和 v1 非目标分开描述。
- 已将真实服务器、平台工具链、签名证书、许可证/CVE 数据源和产品决策列为外部前置条件。
- 阶段 1 初始交付时只新增本清单文件；后续执行阶段按职责增量修改了 RDP 实现、测试、构建配置和证据文档，未执行重置、清理或删除用户改动。

## 7. 本轮执行记录（A0）

### 7.1 阶段状态

- RDP-001、RDP-002：已完成；RDP-003 的契约、配置 UI、持久化和国际化自动化验证通过，但真实 Electron 截图 QA 尚未完成。
- RDP-004、RDP-005：Native Worker、Unicode、dirty-region、矩形帧校验、MessagePort 和背压契约已实现；真实 IME、真实服务器和高分辨率连续帧仍为 `BLOCKED_EXTERNAL_ENV`。
- RDP-006：Windows x64 FreeRDP Worker、运行库 staging、package gate、4 项 CTest 和 disabled 平台门禁通过；完整 electron-builder 因本机缺少 Visual Studio 被阻塞，因此任务整体为 `BLOCKED_EXTERNAL_ENV`。
- RDP-007、RDP-008：许可证/SBOM/CVE、签名、公证和时间戳证据缺失，不能签核。
- RDP-009、RDP-010：真实性能和真实服务器端到端 smoke 未执行，环境变量缺失时 smoke 只输出 skip，不能算 PASS。
- RDP-011：Android `OUT-OF-SCOPE`；保留 profile/schema 兼容性，不实现 Android RDP UI、JNI 或 Native 引擎。

### 7.2 本轮验证摘要

| 验证 | 结果 |
| --- | --- |
| `npm test` | `108 files passed, 1566 tests passed, 5 skipped files, 37 skipped tests` |
| 定向 RDP Vitest | `10 files passed, 63 tests passed` |
| `npm run typecheck` | PASS |
| `npm run check:i18n` | PASS；10 种语言 |
| `npm run build` | PASS |
| Windows x64 FreeRDP Worker build | PASS；FreeRDP 3.30.0，非 mock |
| Windows x64 CTest | PASS；`4/4` |
| Windows x64 package gate | PASS |
| Windows ARM64、macOS x64/arm64、Linux x64/arm64 disabled gate | PASS；明确缺省，不打包 mock |
| 真实 RDP smoke | BLOCKED_EXTERNAL_ENV；未设置测试环境变量，脚本跳过 |
| Android unit test | BLOCKED_EXTERNAL_ENV；系统无 `gradle`，仓库无 wrapper |

### 7.3 发布判定

最终状态：`NOT_READY`。Windows x64 的代码和工程构建基础已具备，但 RDP-007、RDP-008、RDP-009、RDP-010 是本轮 P0 发布门禁，当前均没有可放行证据。完整依据见 `project-docs/rdp-native-evidence-qa.md` 和 `project-docs/rdp-native-final-acceptance.md`。
