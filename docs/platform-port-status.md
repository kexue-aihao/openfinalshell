# 多端功能增量移植实施与验收记录

记录日期：2026-09-16。实施基线：`b7fd8ca` / `0.30.23`；本次改动纳入 `0.30.24`，以下结果为本地验证，远端发布结果以对应标签的 GitHub Actions 为准。可用硬件只有 Windows x64；没有 macOS、Linux 或 Android 实机。本机已新增 Android API 26/35 x86_64 模拟器。此前 README 等文档修改一并保留。

## 工作包状态

| 工作包 | 代码交付 | 自动验证 | 实机与正式开放 |
|---|---|---|---|
| M0 | 主进程能力报告、Worker 五项细分能力、旧协议保守降级、会话 generation 与剪贴板 taskId 隔离；AI/命令库共享 schema 和样例 | TypeScript、桌面全量测试、i18n、构建通过 | Windows 基线保持；其他平台按功能准入 |
| D1 | Unix 独立 sessionData、私有 socket 目录和死亡实例清理；macOS 菜单/Linux desktop 动作；NSPasteboard/GTK3 主循环剪贴板 | Windows 多进程冒烟通过；Unix 代码待对应平台构建运行 | macOS/Linux 多实例默认关闭，Keychain/libsecret、X11/Wayland 待验收 |
| D2 | 平台无关 descriptor、按块上传；远程选择集完整缓存后发布复制 URL；取消、所有权和缓存清理；Windows OLE 保留 | Windows FreeRDP 8 项 CTest 通过；取消/迟到事件主进程回归通过 | Finder、Nautilus/Dolphin/Thunar、Flatpak 未验收，文件能力默认关闭 |
| D3 | 真实音频插件与设备 Open 状态；动态依赖收集、RPATH 修复；签名/公证 feed 门禁；Linux 手动安装指引 | 打包配置 schema、脚本语法通过；Windows 音频回调测试通过 | macOS/Linux 实际播放、签名公证更新与干净环境包启动待验收 |
| A1 | HTTP CONNECT/SOCKS5 认证代理接入 MINA、目标主机密钥校验；SAF 文件/目录和设置接线、续传/重试 | 本地代理握手、传输队列通过；API 26/35 系统文件接口读写、pipe 和权限拒绝通过；Debug/Release 构建通过 | 实际云文档 provider、旋转/后台恢复与设备传输待验收 |
| A2 | 设置中的 AI 配置、模型选择/能力声明/探测、延迟、SSE/JSON、取消；SSH 助手；命令分组/搜索/导入同步/安全填入、可选历史 | 本地 HTTP 模拟测试及跨语言 fixture；API 26/35 Room/Keystore 仪器测试通过 | 真实 OpenAI/DeepSeek/第三方 Token 和 ARM64 实机待验收 |
| A3 | 五种远程文本编码、BOM/换行保留、冲突/原子保存；递归与 USTAR 打包上传下载 | 编辑、归档、暂停/取消/重试测试与 AAPT2 通过 | 原子替换支持差异、磁盘不足、真实服务器和 Android 文件 provider 待验收 |

“已接入”表示代码路径存在，不等于平台实机验收或正式发布已完成。全部子智能体通过本会话协作工具工作，没有另开 Codex 任务。

## 可复现自动检查

桌面：

```text
npm run typecheck
npm run check:i18n
npm test
npm run build
npm run check:bundle
npm run smoke:multi-instance
ctest --test-dir <真实 FreeRDP 构建目录> --output-on-failure
```

本机结果：桌面全量测试 1,716 项通过、37 项按环境条件跳过；随后新增的 macOS 更新清单门禁 7 项测试通过，覆盖架构、重复清单、ZIP、缺失文件、校验值和路径逃逸。Windows FreeRDP 8/8 CTest 通过。三独立 Electron 进程的 13 个场景通过，覆盖共享配置并发、过期修改拒绝、真实本地 SSH/SFTP、文件内容一致、AI 请求隔离、单窗关闭、协调交接、重启解密和日志无测试凭据。没有执行真实外部 RDP 文件粘贴或更新安装器。

Android 标准验证命令（CI 已有 API 26/35 模拟器与 ABI 检查）：

```text
node scripts/generateSharedSchema.mjs
.\android\gradlew.bat -p android :app:checkI18n testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest
.\android\gradlew.bat -p android :app:connectedDebugAndroidTest
.\android\gradlew.bat -p android :app:lintDebug :app:assembleRelease :app:bundleRelease
```

用户已授权本机直连，不再以 `127.0.0.1:7897` 代理作为本次构建前提。Gradle 8.10.2 与 Wrapper JAR 均通过官方 SHA-256 校验，仓库新增 Wrapper 和固定发行包校验值；设置 JDK 17 的 `JAVA_HOME` 及 SDK 35 的 `ANDROID_HOME` 后即可运行上述命令。macOS/Linux 使用 `sh android/gradlew -p android`。

完整 Gradle 结果：核心 47 项、存储 9 项、应用 14 项，共 70 项单元测试通过，无失败或跳过；十语言检查、Room KSP 与 v4 schema 导出通过；arm64-v8a、armeabi-v7a、x86_64、x86 和 universal 五个 Debug APK 及仪器测试 APK 构建通过。修复了 AI 测试依赖 JDK 专有 HttpServer、Android Gradle 无法编译的问题，改为 MockWebServer，并明确使用回环 IP，避免 Windows 主机名反查影响 HTTP URL 校验。

API 26 和 API 35 的 x86_64 模拟器本次各通过 12 项仪器测试（0 失败、0 跳过）：原有主界面导航、v3→v4 迁移、Keystore Token 替换/清除/过期冲突与导出隔离，加上 9 项 SAF 测试。SAF 使用测试 APK 中的独立文件提供器进程和真实 ContentResolver/PFD，验证偏移读取、暂停后续传、重试截断、pipe 文档从头重开、错误偏移、非法名称、中文目录和权限撤销。修复 `canSeek` 吞掉 SecurityException 的问题，避免把权限丢失误当作“不支持续传”。测试提供器不进入 Debug/Release 应用 APK，已检查合并后的 Manifest。

两次新增测试结果保存在 `build/android-port-validation/saf-api26-results`、`saf-api35-results`，汇总及 Debug 包哈希位于同目录的 `verification.json`（不提交生成目录）。这些测试不代表 SAF 全场景、系统选择器 UI、真实 SSH/AI 服务或 ARM64 实机验收完成。

此前本地验证产物为 Debug 签名测试包，使用 Android 工程默认版本号 `0.20.20`，未使用正式发布签名；`0.30.24` 正式包由 CI 注入标签版本号、版本码和发布签名。通用测试包路径为 `android/app/build/outputs/apk/debug/app-universal-debug.apk`。

本次续作补查 Release 构建：修复网络安全配置缺少 `includeSubdomains="false"` 导致 `lintVitalRelease` 失败的问题；本地没有签名凭据时允许生成明确标为 unsigned 的 APK/AAB，发布工作流使用 `-PrequireReleaseSigning=true` 强制完整签名。缺少签名和只配置部分签名均已验证会拒绝。五种 Release APK 与 AAB 本地构建通过；产物只用于构建验证，不能当作正式安装包发布。

完整 `lintDebug` 通过，0 错误、85 条警告（另有 1 条提示）。补齐繁中、日、韩、德、法、西、葡、俄各 128 条既有界面缺失翻译；`checkI18n` 从设置/新增功能扩展为所有可翻译字符串。CI 增加完整 lint 和无签名 Release APK/AAB 构建，正式发布仍要求完整签名。警告主要为依赖版本、文案排版、未使用资源、图标/备份配置和缓存空间建议；两项 TrustManager 警告来自 MINA 依赖中的 TLS 类，本次源码未使用该类，AI HTTP 客户端未配置绕过证书校验。

新增界面资源覆盖现有十种语言，键集、格式占位符和 Android 资源编译检查通过；en/zh-CN 为基准，其他语言已完成初译，仍需母语校对。

Android 命令历史仅记录用户在命令面板中显式执行的命令，不捕获原始终端键盘输入、密码提示或远程输出。AI 回答填入 SSH 不附加回车；多行或控制字符输入会被拒绝，用户可以复制后自行检查。终端选区超过上限时明确提示，不静默截断。

## 发布准入

- `src/main/services/platformCapabilities.ts` 为平台准入来源；macOS/Linux 的多实例、文件剪贴板和音频保持关闭。Worker 与实际设备状态还要再次满足能力检查。环境变量不能绕过正式包能力门禁。
- 未连接时全局能力报告标明“连接后检测”；会话能力由当前 Worker HELLO 和音频设备回调给出。旧 Worker 不推断文件/音频能力。
- macOS 自动安装更新要求 `MAC_UPDATE_ACCEPTED=true` 仓库变量和全部签名/公证 secrets；缺任一项走手动更新。签名构建强制签名，校验架构 feed/ZIP/SHA512。Linux 保持手动更新，无应用内提权安装 DEB/RPM。
- Windows ARM64/x86 不新增真实 Worker；Android RDP 仍需另行技术验证。
- 用户已授权提交、推送和发布；`0.30.24` 的 Android 签名包已发布，桌面 CI 在 macOS 测试临时路径的符号链接检查处失败。`0.30.25` 将测试根目录解析为真实路径，并补充文件及父目录符号链接拒绝用例，生产安全检查不变；CI 按新标签构建正式安装包，未验收的平台能力保持关闭。

## 下一次平台实机验收

每条记录必须写明提交、安装包哈希、OS/架构、显示协议、文件管理器、结果和失败步骤；不得记录密码、Token 或文件内容。

1. macOS Intel/Apple Silicon，Linux x64/ARM64 的 X11/Wayland：真实 Worker 启动、连接/断开/缩放、文本双向复制、多实例和安全存储交接。
2. Finder、Nautilus、Dolphin、Thunar：中文/空格、空文件、多文件、目录、大小/哈希一致；取消、磁盘不足、覆盖、剪贴板替换及关闭会话后粘贴失败；另验 Flatpak。
3. 关闭再手动连接至少十次，确认旧 Worker 认证、帧、传输事件不影响新会话。
4. 音频须实际听到播放，更新须验证对应架构的签名 feed 与协调退出；不能用通道连接或构建成功代替。
5. Android API 26/35、ARM64 实机与 x86_64 模拟器：代理拒绝不直连、SAF 权限失效、并发/覆盖/恢复、编辑冲突、旋转和后台恢复、AI 三类接口及取消。APK 四 ABI 均需构建。
