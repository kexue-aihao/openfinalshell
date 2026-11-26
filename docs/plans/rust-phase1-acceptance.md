# Rust Phase 1 验收记录（lansync）

对应计划书 §4.4。本文件是**执行记录**，不是承诺：每条都写清「怎么跑」「现在什么结果」。

状态图例：✅ 通过 · ⏳ 待跑（本机缺条件） · ⚠️ 有已知差异（见 `docs/rust-native-rollout.md` §7）

## 0. 环境（2026-11-26 实测）

| 项 | 结果 |
|---|---|
| rustup / rustc | ✅ `rustc 1.100.0 (0ef1bc386 2026-11-09)` / `cargo 1.100.0` |
| 锁定 | `rust/rust-toolchain.toml` channel = `1.100.0`，components `rustfmt` + `clippy` |
| MSVC 链接器 | ✅ Visual Studio 2022 Build Tools 17.14 + Win11 SDK 10.0.26100（`LNK1181: dbghelp.lib` 只在 SDK 装完前出现过） |
| Node | ✅ v26.13.0（CI 用 24；本项目无 `engines` 约束） |
| 产物体积 | ✅ `ofs_napi.node` 611,840 字节（≈0.6 MB，预算 < 5 MB） |

## 1. 契约层（L1）

| 检查 | 命令 | 结果 |
|---|---|---|
| golden 与 TS 实现一致 | `node scripts/generateLansyncGolden.mjs --check` | ✅ 58 条（29 accept / 29 reject） |
| golden 可重复生成 | 连续两次生成字节相同 | ✅ |
| Rust 与 golden 一致 | `cargo test -p ofs-lansync --test golden` | ✅ 2 个用例（全量 58 条 + 分块投递） |
| 数字格式表 | `cargo test -p ofs-lansync js_json` | ✅ 14 个数字形态逐字节对 `JSON.stringify` |
| UTF-16 计长 | `cargo test -p ofs-lansync string_lengths` | ✅（64 emoji 通过 / 65 emoji 拒绝） |

## 2. 差分层（L2）

| 检查 | 命令 | 结果 |
|---|---|---|
| golden 全量（TS vs Rust） | `npx vitest run test/parity` | ✅ |
| 10,000 例随机帧 | 同上（种子 `0x5eed1a45`，固定可复现） | ✅ 0 例不一致 |

## 3. 行为层（L3）

| 检查 | 命令 | 结果 |
|---|---|---|
| 既有单测零改动 | `npx vitest run test/unit/lansyncProtocol.test.ts` | ✅ 8/8 |
| 既有集成测试零改动 | `npx vitest run test/integration/lansync.test.ts` | ✅ 7/7 |
| 全量 ts lane | `OFS_CORE_BACKEND=ts npx vitest run --no-file-parallelism --maxWorkers=1` | ✅ 133 文件 / 1788 用例 |
| 全量 rust lane | `OFS_CORE_BACKEND=rust …` | ✅ 134 文件 / 1790 用例（差分 2 例由 skip 转为执行） |
| 后端开关语义 | `npx vitest run test/unit/nativeBackend.test.ts` | ✅ 7/7（ts / rust / auto / 熔断 / 非法值） |

## 4. 打包与开关

| 检查 | 命令 | 结果 |
|---|---|---|
| 构建脚本 | `npm run build:native-addon -- --platform win --arch x64` | ✅ 41 s 冷构建，产物 0.6 MB |
| staging 校验 | `npm run check:native-addon -- --platform win --arch x64` | ✅ `PE addon loads (0.1.0/windows/x86_64)`（含 self-test） |
| 回退 staging | `… --package-disabled` + `check:native-addon -- --expect-absent` | ✅ |
| `OFS_CORE_BACKEND=rust` 缺件必须启动失败 | `test/unit/nativeBackend.test.ts` | ✅ 导入即抛错 |
| `OFS_NATIVE_DISABLE=1` 熔断 | 同上 | ✅ `reason === 'OFS_NATIVE_DISABLE=1'` |
| 删除 `build/ofs-native` 后仍能局域网同步 | 拆帧/编解码全量单测在无 `.node` 时通过 | ✅（回退生效） |
| 打包产物含 `resources/ofs-native/ofs_napi.node` | `check:native-addon --app-dir …` | ⏳ 需先出 unpacked 包（本机缺 FreeRDP worker，`package:dir` 走不通） |
| typecheck / i18n / bundle | `npm run typecheck && npm run check:i18n && npm run check:bundle` | ✅ 全绿 |
| 主进程产物可构建 | `npm run build` | ✅（`createRequire` 不能触发 ESM/CJS shim —— 首版用 `import.meta.url` 时确实炸过，已改为 `process.execPath`） |

## 5. 回滚演练

| 级别 | 操作 | 结果 |
|---|---|---|
| 单机熔断 | `OFS_NATIVE_DISABLE=1` → `nativeStatus().active === 'ts'` | ✅ |
| 单版本回退 | `--package-disabled` 后整模块走 TS | ✅ |
| 代码回退 | 去掉 `protocol.ts` 的委派分支，`test/parity` 自动 skip | ✅（skip 路径已实测） |

## 6. CI 侧（未在本机跑过）

新增 `.github/workflows/rust-core.yml`（9 目标矩阵 + Android 只编译 + tag 发布）、
`build-linux.yml`、`build-macos.yml`，并在 `ci.yml` 增加了 cargo 三连与 rust 后端 lane。
YAML 已用 `js-yaml` 解析验证，但**整条流水线只能在 GitHub 上验证**。

## 7. 已知差异

见 `docs/rust-native-rollout.md` §7：`params` 中的超范围数字、孤立代理对、
「一个 chunk 里先合法帧后非法帧」三种情况的行为差异均已记录，且都不影响线上字节。
