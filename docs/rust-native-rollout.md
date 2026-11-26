# Rust 原生模块（lansync）上线与回滚手册

Phase 1 只接管一个模块：`src/main/lansync/protocol.ts` 的编解码。TS 实现原样保留，
Rust 是**可选增强**：`.node` 缺失、加载失败、被熔断时，整个模块回退到 TS。

## 1. 开关

| 环境变量 | 取值 | 语义 |
|---|---|---|
| `OFS_CORE_BACKEND` | `auto`（默认） / `ts` / `rust` | `ts` 强制不走原生；`rust` 必须有原生，缺失即启动失败（CI 的 rust lane 用它）；`auto` 按加载顺序尝试，失败静默回退 |
| `OFS_NATIVE_DISABLE` | `1` / `true` / `on` | 全局熔断，优先级最高 |
| `OFS_NATIVE_PATH` | 绝对路径 | 显式指定 `.node`（开发与 CI 用） |
| `OFS_RUST_MODULES` | 逗号分隔，默认 `lansync` | 当前只有 `lansync` 一个可选项；不含它即整模块回退 |

非法 `OFS_CORE_BACKEND`（例如 `rsut` 拼错）会**直接抛错**，不会被当成 `auto` 静默吞掉。

## 2. 加载顺序

1. `OFS_NATIVE_PATH` 指定的文件
2. 打包态：`<process.resourcesPath>/ofs-native/ofs_napi.node`
3. 开发态：`build/ofs-native/<platform>-<arch>/ofs_napi.node`

`<platform>` 取 `win` / `mac` / `linux`，`<arch>` 取 `x64` / `ia32` / `arm64`。
任一文件存在但加载失败（架构不符、ABI 不符、缺依赖）→ 记一条 warn，继续看下一个候选。

## 3. 回退三级

1. **单机熔断**：`OFS_NATIVE_DISABLE=1`。不用重装、不用改配置。
2. **单版本回退**：发版时不跑 `build:native-addon`，改跑
   `npm run build:native-addon -- --platform <p> --arch <a> --package-disabled`。
   staging 目录里只有 `OFS-NATIVE-UNAVAILABLE.txt`，`auto` 模式下自动整模块回退 TS。
3. **代码回退**：`protocol.ts` 里每处委派都是 `native ? native.xxx() : 原实现`。
   删掉 `import` 与那几行分支即可回到纯 TS；`test/parity` 会自动 skip。

回退只发生在**模块实例创建时**。`FrameReader` 一旦用原生构造，后续 `feed` 抛错
必须原样抛给调用方（连接随之销毁），不允许中途换回 TS 重放缓冲区 —— 帧边界不可信时，
这条流上后面的每个字节都不可信。

## 4. 本地构建

```bash
# 一次性：rustup（本机已有则跳过）
curl -sSfL -o rustup-init.exe https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe
./rustup-init.exe -y --default-toolchain stable --profile minimal -c rustfmt -c clippy

# 构建 + 暂存
npm run build:native-addon -- --platform win --arch x64
npm run check:native-addon -- --platform win --arch x64

# Rust 侧自检
npm run rust:fmt && npm run rust:clippy && npm run rust:test
```

Windows 上需要 MSVC 链接器（Visual Studio Build Tools 的 C++ 工作负载）。
**注意**：Git Bash 的 `/usr/bin/link` 会抢占 `link.exe`，报
`link: extra operand ...`。`scripts/stageNativeAddon.mjs` 已把 MSVC 的 bin 目录
提到 PATH 前部；手工跑 `cargo` 时要么用 “x64 Native Tools Command Prompt”，
要么自己 `export PATH="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/<ver>/bin/Hostx64/x64:$PATH"`。

## 5. 诊断

`src/main/core/native.ts` 的 `nativeStatus()` 返回：

```ts
{ backend: 'auto', active: 'rust', path: '…/ofs_native.node', version: '0.1.0/windows/x86_64', reason: null }
```

回退时 `active: 'ts'`，`reason` 会写明原因（`OFS_NATIVE_DISABLE=1` /
`OFS_CORE_BACKEND=ts` / `OFS_RUST_MODULES 不含 lansync` / `no loadable addon`）。
日志里对应的是 `[ofs] native lansync loaded: …` 或 `[ofs] native unavailable`。

## 6. 打包位置

`.node` 走 `extraResources` 进 `resources/ofs-native/`，**不进 asar、不进 npm 依赖树**：

- 因此不会被 `electron-builder install-app-deps` / electron-rebuild 重编（ABI 事故的第一大来源）；
- 因此也不受 `asarUnpack: '**/*.node'` 影响（那条规则是给 ssh2 的可选 binding 用的）。

`scripts/checkNativePackaging.mjs --app-dir release/<arch>-unpacked` 会按 PE/ELF/Mach-O
头校验架构，并把打包内的文件与 staging 的 sha256 对齐。

## 7. 已知差异（刻意保留）

- `params` 里的数字若超出 f64（JSON 文本 `1e999`），TS 会得到 `Infinity`，Rust 侧落成
  `null`。重新编码时 TS 也输出 `null`，所以线上字节仍一致；只是解码后的对象在内存里
  不同，且 zod 本来就允许。真实客户端不会发这种值。
- 孤立代理对（`"\ud800"`）TS 能解析，Rust 的 JSON 解析器会拒绝并归到「不是合法 JSON」。
  同样不会出现在真实客户端里。
- 一个 `feed` 调用里「先合法帧、后非法帧」时，TS 会先回调前面的帧再抛错，Rust 会把
  这一批整体判错。调用方收到异常后立即断连，差异不可观测。
