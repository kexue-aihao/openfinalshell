# 原生 RDP 多智能体编排计划

> 基线：`project-docs/rdp-native-worker-audit.md`（2026-09-04）
>
> 目标：在不破坏现有 SSH、SFTP、监控和既有 RDP 协议测试的前提下，将当前 Windows x64 RDP 原型推进到可验收、可发布的状态，并对其他平台作出有证据的支持结论。

## 1. 编排范围

本计划只处理审计中确认的缺口，不默认增加音频、打印机、磁盘、摄像头、智能卡、USB、多显示器或 RD Gateway 等 v1 未承诺能力。每项工作必须产生代码、测试、构建证据或明确的发布决策；不能以“后续再做”替代验收结论。

当前基线：

- Windows x64 FreeRDP Worker、Electron 主进程、IPC、preload、Renderer Canvas 和会话 Tab 已连通。
- 已有协议、Worker 构建、CTest、package gate 和全量测试通过记录。
- 尚无真实 RDP 服务器的端到端 PASS 记录。
- 当前工作区存在用户已有的未提交改动，所有智能体必须采用增量修改，不得重置、清理或覆盖无关改动。

## 2. 智能体职责

| 编号 | 子智能体 | 职能 | 主要交付物 |
|---|---|---|---|
| A0 | `agents-orchestrator` | 总编排、依赖调度、状态记录、质量门禁、失败升级 | 本计划执行记录、阶段状态、最终汇总 |
| A1 | `project-manager-senior` | 把审计结论转换为边界清晰的任务清单和验收标准，冻结 v1 范围 | `project-tasks/rdp-native-tasklist.md` |
| A2 | `ArchitectUX` | 设计 RDP 配置模型、编辑页、证书策略和会话状态的完整交互及 IPC 边界 | `project-docs/rdp-native-architecture.md` |
| A3 | `Backend Architect` | 审查 `RdpSessionManager`、IPC、Worker 生命周期、重连和错误状态，给出主进程契约方案 | 主进程/IPC 设计、契约测试清单 |
| A4 | `engineering-senior-developer`（Native） | 负责 FreeRDP C++ Worker、Unicode/IME、帧传输、尺寸校验和输入协议 | native 代码、CTest、Worker 协议测试 |
| A5 | `Frontend Developer` | 负责 Profile 编辑页、RDP 设置持久化、Renderer 输入/Canvas 和用户可见状态 | React/TypeScript/CSS、Renderer 测试 |
| A6 | `DevOps Automator` | 负责 Worker 构建矩阵、开发环境定位、打包、签名、公证和 CI 门禁 | 构建脚本、workflow、发布检查 |
| A7 | `Legal Compliance Checker` | 负责 FreeRDP 及完整原生依赖链的许可证、SBOM、CVE 和发布记录 | 第三方声明、SBOM、漏洞审计报告 |
| A8 | `Performance Benchmarker` | 负责高分辨率帧率、带宽、内存、稳定性和输入延迟基准 | 性能基准报告、回归阈值和测试脚本 |
| A9 | `EvidenceQA` | 对每个开发任务执行针对性测试，要求日志、测试结果和必要的 UI 截图 | 每任务 PASS/FAIL 证据 |
| A10 | `testing-reality-checker` | 对打包产物和真实运行环境做最终集成认证，默认严格判定 | 最终 `READY` / `NEEDS_WORK` / `NOT_READY` 报告 |
| A11 | `Mobile App Builder` | 仅在产品决定 Android 原生 RDP 属于本轮范围时评估并实现移动端方案 | Android 支持决策或独立实施方案 |

职责边界：A4 不修改 Renderer UI；A5 不绕过 Worker 直接实现协议；A6 不把 mock Worker 当成生产降级方案；A7 不替代平台签名验证；A8 不用主观“感觉流畅”作为性能结论；A9 只依据可复现证据放行。

## 3. 阶段与依赖

```text
阶段 0 基线冻结
        |
阶段 1 A1 任务拆分
        |
阶段 2 A2/A3 架构与契约
        |
  +-----+--------+--------+---------+
  |              |        |         |
  B 配置/UI    C Native  D 构建    E 安全/合规
  A5 + A9      A4 + A9   A6 + A9   A7
  |              |        |         |
  +--------------+--------+---------+
                 |
          阶段 3 集成与性能
          A8 + A3/A4/A5 + A9
                 |
          阶段 4 真实服务器验收
          A6 + A10 + A9
                 |
          阶段 5 发布决策
          A7 + A10 + A0
```

阶段 2 完成后，B、C、D、E 可以并行，但同一文件或同一契约上的修改必须由 A0 排队。阶段 3 必须等待 B、C、D 的 QA 均通过；阶段 4 必须使用阶段 3 生成的最终 Worker 和应用构建产物。macOS/Linux/ARM64 的发布开启不得早于对应平台 Worker 构建、依赖、签名和真实服务器验收全部通过。

## 4. 任务清单与验收门禁

### RDP-001：范围、基线和任务清单

- 负责人：A1；复核：A0。
- 输入：`rdp-native-worker-audit.md`、当前测试结果、当前工作区状态。
- 内容：区分 P0/P1/P2；明确 Windows x64 v1 必须项、跨平台条件项和暂不支持能力；登记真实服务器、签名证书、构建矩阵等外部前置条件。
- 验收：每个审计缺口都有唯一任务 ID、负责人、依赖、测试命令和通过标准；未把未实现能力误报为已完成。
- 交付：`project-tasks/rdp-native-tasklist.md`。

### RDP-002：架构、契约和 UX 冻结

- 负责人：A2、A3；复核：A0、A9。
- 内容：定义 RDP profile 字段和敏感字段生命周期；证书 `prompt`/`strict` 行为；clipboard 持久化；Worker、main、preload、renderer 的消息契约；重连和旧 Worker 事件隔离；macOS/Linux/ARM64 的能力声明和降级语义。
- 验收：架构文档能逐项映射到现有文件；新增字段不会破坏旧 profile；密码不进入 argv、日志或普通 Renderer 状态；所有错误状态都有用户可见结果。
- 交付：架构文档和契约测试计划。未通过时不得进入并行开发。

### RDP-003：RDP 配置编辑与持久化

- 负责人：A5；协作：A3、A2；QA：A9。
- 目标文件范围：`src/renderer/src/features/connections/ProfileEditDrawer.tsx`、连接模型/store、相关 locale 和测试。
- 必须支持：Domain；clipboard 开关；证书策略选择；编辑已有 profile 时保留字段；清除已保存密码；旧配置兼容；表单验证和国际化。
- 验收：新增、编辑、取消、保存、清除密码五条流程均有自动化测试；渲染器截图显示控件和错误状态无重叠；敏感字段不会回显到普通日志。
- 依赖：RDP-002。

### RDP-004：Unicode、键盘布局和 IME 输入

- 负责人：A4；协作：A5；QA：A9。
- 目标范围：`RdpPane.tsx`、preload/input contract、`freerdp_adapter.cpp` 及 native 测试。
- 必须支持：扫描码路径、扩展键、Unicode 输入路径、非英文字符、组合键、死键和至少一套 IME 场景；明确无法支持的系统级输入限制。
- 验收：中英文、日文或韩文输入各有可重复测试；Unicode 字段从 Renderer 到 FreeRDP API 的链路有契约证据；输入失败能安全断开或回报错误，不得静默吞掉。
- 依赖：RDP-002。

### RDP-005：帧传输、校验和稳定性

- 负责人：A4；协作：A3、A8；QA：A9。
- 必须完成：核对 dirty-region 语义；避免无必要的整屏复制；统一 main 与 renderer 的宽高、stride、payload 和像素上限校验；评估 stdout 大帧的 `Buffer.concat` 开销；保持背压、ACK、超时和最新帧替换行为。
- 验收：在 1920x1080 及至少一个高分辨率场景下有 CPU、内存、IPC payload 和帧率数据；损坏尺寸、超 stride、超 64 MiB 和连续帧压力测试均被拒绝或降级；没有旧帧/旧 Worker 事件污染新会话。
- 依赖：RDP-002；RDP-004 可并行。

### RDP-006：Worker 开发、构建和平台矩阵

- 负责人：A6；协作：A4；QA：A9。
- Windows x64：保持 `require-freerdp`、CTest、package gate 和最终 App 资源校验。
- macOS/Linux/Windows ARM64：分别验证 FreeRDP 编译、运行时依赖、架构、打包体积、启动和失败提示；在证据不足时明确标记为 unsupported，不得打包 mock Worker 冒充原生支持。
- 本地开发：修复或明确 `npm run dev` 的 Worker 自动发现、资源 staging 和错误诊断路径。
- 验收：每个目标有构建日志、依赖清单、启动自测、package gate 结果；CI 对未支持目标做“预期缺失”检查，对已支持目标做“必须是真 FreeRDP”检查。
- 依赖：RDP-002；平台并行，但每个平台独立 QA。

### RDP-007：许可证、SBOM、CVE 与原生发布安全

- 负责人：A7；协作：A6；复核：A0。
- 必须核对：最终分发物中实际 DLL/动态库的版本和来源；FreeRDP、WinPR、OpenSSL、编解码库及其传递依赖；许可证文本、NOTICE、源码/归属要求；SBOM；高危和不可接受漏洞；Worker 与 Electron 资源的完整性。
- 验收：许可证清单按最终产物而非构建环境生成；SBOM 能追溯版本；CVE 有结论和例外审批；package gate 在 CI 中失败可阻止发布。
- 依赖：RDP-006 产出最终依赖清单后完成最终签核；初步策略评审可提前进行。

### RDP-008：代码签名、公证和平台信任

- 负责人：A6；安全复核：A7；QA：A9。
- Windows：验证应用和 Worker 的签名范围、证书链、时间戳、SmartScreen 相关发布产物检查。
- macOS：验证应用、Worker、嵌套动态库的签名、entitlements、公证和 stapling；没有完成自动签名时不得宣称 macOS 原生 RDP 可发布。
- 验收：在干净环境安装并启动；签名验证命令有成功日志；篡改 Worker 后能被检测；签名失败能阻止 release job。
- 依赖：RDP-006、RDP-007。

### RDP-009：真实性能与长稳测试

- 负责人：A8；协作：A4、A3；QA：A9。
- 场景：1920x1080、30 FPS 目标、至少 60 秒稳定连接；窗口缩放/动态分辨率；持续鼠标移动和键盘输入；剪贴板往返；网络抖动与断开；重连；GPU/Canvas context loss（可用时）。
- 指标：首帧时间、稳定帧率、帧丢弃率、CPU、内存增长、IPC 吞吐、输入 p95 延迟、断线恢复时间。
- 验收：A8 与 A0 先确认阈值；测试结果可重复并保存原始日志；不满足阈值必须生成优化任务，不能仅调整报告措辞。
- 依赖：RDP-003、RDP-004、RDP-005、RDP-006。

### RDP-010：真实 RDP 服务器端到端验收

- 负责人：A10；执行：A9；协作：A6、A3、A4、A5。
- 前置：授权的 Windows RDP 测试服务器、测试账号、可选 Domain、端口和证书场景。凭据只通过环境变量注入，不写入仓库或日志。
- 场景：成功认证；错误密码；Domain；证书 prompt 接受/拒绝；首帧；键盘、Unicode、鼠标、按钮、滚轮；动态分辨率；clipboard；服务端断开；客户端关闭；重连；Worker 替换和旧事件隔离。
- 验收：`scripts/smokeRdpWorker.mjs` 有 accepted 与 rejected certificate 的明确记录；应用级断线重连有真实服务器证据；最终构建产物而非开发 mock 通过测试。
- 依赖：RDP-003 至 RDP-009 中涉及的任务均通过；真实环境是必要外部前置条件。

### RDP-011：Android 范围决策（条件任务）

- 负责人：A11；产品复核：A1、A0。
- 内容：确认 Android 是否属于本轮“软件内原生 RDP”范围；若属于，评估 FreeRDP/Android UI、输入法、证书、剪贴板、网络生命周期和打包方案；若不属于，补充兼容性边界文档，避免 profile 可解析被误解为 RDP 已支持。
- 验收：有明确的 IN-SCOPE 或 OUT-OF-SCOPE 决策、理由、后续版本目标和测试边界。
- 依赖：RDP-001；不阻塞 Windows x64 发布，但必须在最终报告中声明。

## 5. 开发-QA 循环

每个实现任务（RDP-003 至 RDP-011 中适用者）严格执行以下循环：

1. 负责人智能体先读取 RDP-001/RDP-002、目标文件和当前测试，再实现最小完整变更；不得修改无关模块。
2. A9 按任务验收标准执行测试，并在需要时用真实 Electron 窗口截图验证 UI；测试输出、截图路径、环境和 commit/worktree 状态必须记录。
3. `PASS` 才能推进。`FAIL` 必须附具体失败命令、复现步骤、影响范围和修复建议返给原负责人。
4. 每项任务最多 3 次开发-QA 尝试。第三次仍失败则标记 `BLOCKED`，由 A0 记录阻塞原因和最小升级决策，不得静默跳过。
5. QA 本身失败时最多重试 2 次；截图不可用或证据含糊时按 `FAIL` 处理。

任务状态使用：`TODO`、`IN_PROGRESS`、`QA`、`PASS`、`FAIL_RETRY`、`BLOCKED`。只有 `PASS` 可以满足依赖；`BLOCKED` 不得被当作完成。

## 6. 执行顺序

### 阶段 0：基线冻结

A0 记录当前分支、工作区 dirty 状态、现有测试基线和审计文档版本。禁止任何智能体执行 `git reset --hard`、`git checkout --`、批量删除或清理用户已有构建产物。

### 阶段 1：PM 任务化

A1 生成任务清单并由 A0 复核范围。输出不合格时退回 A1，最多 3 次。

### 阶段 2：架构与 UX

A2/A3 并行阅读现有实现后共同冻结 profile、IPC、Worker 和错误状态契约。A9 做契约级 QA，A0 通过后才派发实现任务。

### 阶段 3：并行开发轨道

- B 配置/UI：RDP-003。
- C Native：RDP-004、RDP-005；RDP-004 先于 RDP-005 的输入/帧联合验证，但两项代码可在不同文件并行。
- D Platform：RDP-006，先完成 Windows x64 现有链路回归，再处理其他平台。
- E Security：RDP-007 初审可并行，最终签核等待 RDP-006。

每条轨道单独经过 A9；轨道内任务按依赖串行，轨道之间只共享已冻结的契约。

### 阶段 4：集成、性能和真实环境

A3/A4/A5 集成 RDP-009 所需观测点，A8 执行基准，A9 验证。随后 A6 准备最终打包产物，A9/A10 在授权真实服务器上执行 RDP-010。没有真实服务器凭据时，该阶段状态只能是 `BLOCKED_EXTERNAL_ENV`，不能报告生产就绪。

### 阶段 5：发布决策

A7 完成最终许可证/SBOM/CVE 签核，A6 完成签名与公证，A10 进行最终现实检查，A0 汇总并决定：

- `READY`：Windows x64 的功能、性能、真实服务器、依赖安全和签名门禁全部通过。
- `NEEDS_WORK`：核心链路可用，但存在明确的非阻塞缺口，例如其他平台尚未启用或 P2 能力未实现；必须列出发布说明和限制。
- `NOT_READY`：真实服务器、认证、证书、输入、稳定性、打包安全或签名任一 P0 门禁失败。

## 7. 质量门禁

每次集成至少运行：

```text
npm test
npm run typecheck
npm run check:i18n
npm run build
npm run build:rdp-worker -- --platform win --arch x64 --require-freerdp
npm run check:rdp-worker -- --platform win --arch x64 --require-freerdp
ctest --test-dir <worker-build-dir> --output-on-failure
npm run smoke:rdp-worker
```

真实 smoke 的环境变量示例只允许由执行环境提供：`OFS_TEST_RDP_HOST`、`OFS_TEST_RDP_PORT`、`OFS_TEST_RDP_USERNAME`、`OFS_TEST_RDP_PASSWORD`、`OFS_TEST_RDP_DOMAIN`、`OFS_TEST_RDP_EXPECT_CERT_PROMPT`、`OFS_TEST_RDP_CERT_REJECT`。密码不得出现在命令行参数、报告、截图或日志中。

最终集成还必须确认：

- 生产 Windows x64 包中存在真实 FreeRDP Worker，mock capability 被拒绝。
- 包中原生 DLL、许可证和运行时 manifest 完整且校验和一致。
- 关闭、断线、重连和 Worker 替换不会留下旧 MessagePort、子进程或敏感数据。
- 不支持的平台给出明确、可翻译且不误导的提示。
- 所有 P0 任务为 `PASS`，所有未完成 P1/P2 项在发布说明中显式列出。

## 8. 交接格式

每个子智能体交接必须包含：

```text
任务 ID：
角色：
修改文件：
未修改的相关文件：
实现摘要：
测试命令及结果：
截图/日志证据：
已知限制：
阻塞项及所需外部条件：
下一位智能体：
```

A0 将交接内容和 QA 结果写回任务清单；任何没有测试证据的“完成”状态自动退回 `QA`。

## 9. 外部前置条件与升级规则

需要用户或发布环境提供但不应写入仓库的条件：

- 授权的 Windows RDP 测试服务器和测试账号。
- Windows/macOS 各目标的构建机或交叉编译工具链。
- 发布签名证书、公证凭据和 CI secret。
- 依赖漏洞扫描服务或固定版本的离线数据库。

A0 只能在同一问题经过 3 次具体修复尝试后升级；外部条件缺失时直接标记 `BLOCKED_EXTERNAL_ENV`，不得通过降低测试标准来放行。最终报告必须区分“代码未完成”和“环境未提供”。

## 10. 预期最终产物

- `project-tasks/rdp-native-tasklist.md`
- `project-docs/rdp-native-architecture.md`
- 各实现任务的代码、单元/集成测试和 EvidenceQA 证据
- Windows x64 及每个已声明支持目标的构建与 package gate 日志
- 最终依赖许可证清单、SBOM、CVE 审计和签名/公证验证记录
- A8 性能基准报告
- A10 最终现实检查报告
- A0 发布决策和剩余限制清单
