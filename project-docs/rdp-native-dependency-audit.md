# RDP-007 原生依赖合规初审

任务：RDP-007
角色：A7 Legal Compliance Checker
审计日期：2026-09-05
范围：Windows x64 FreeRDP Worker 的实际运行时依赖、来源、许可证、SBOM/CVE 和签名证据。
结论：`BLOCKED_EXTERNAL_ENV`，不得作为合规通过或发布签核。

## 1. 执行摘要

本次审计不把“存在任意 LICENSE 文件”视为通过。

- 审计开始时可见的 native staging 快照包含 1 个 Worker、89 个 DLL、`backend: freerdp`，但只有 5 个许可证文件。随后另一项流程用 `--package-disabled` 将 `build/rdp-worker` 改写为仅含 `RDP-WORKER-UNAVAILABLE.txt` 的 `linux/x64` 缺省 staging。当前没有可签核的最终 Worker staging。
- 历史快照中的 DLL 名称可以与本机 `C:/msys64/var/lib/pacman/local` 包数据库匹配到 62 个 MSYS2 UCRT64 包。该证据能说明构建环境来源和版本，但由于最终 staging 已消失，没有最终 DLL 的逐文件哈希、签名和不可变构建清单。
- FreeRDP、WinPR、OpenSSL、FFmpeg 及主要编解码库的版本和包许可证可从 MSYS2 包记录取得；这不是最终分发物的完整许可证交付证明。尤其 FFmpeg、x265、xvidcore、freetype、gettext、zstd、zvbi 等的许可证义务没有随 staging 完整复制并审查。
- 当前没有生成的 SPDX/CycloneDX SBOM，也没有可执行的 CVE 扫描结果。`syft`、`cyclonedx`、`trivy`、`grype`、`osv-scanner` 均不可用；漏洞数据库或服务未提供，因此 CVE 项标记 `BLOCKED_EXTERNAL_ENV`。
- 当前没有 Windows `signtool`、macOS `codesign`/`notarytool` 或等效签名证据。签名、公证、时间戳和篡改检测不能宣称通过。

## 2. 证据和现状

### 2.1 当前 staging

当前读取结果：

```text
build/rdp-worker/RDP-WORKER-UNAVAILABLE.txt
Embedded RDP is not shipped for linux/x64 before NATIVE-03. Use the explicit system-client fallback.
```

因此，当前 `build/rdp-worker` 不包含 `ofs-rdp-worker.exe`、DLL、`rdp-worker-runtime.json`、`THIRD-PARTY-NOTICES.rdp-worker.txt` 或许可证目录。它不能作为 Windows x64 发布证据。

### 2.2 历史 native staging 快照

审计开始时读取到的同一工作区快照如下；该目录后来被并发流程改写，以下内容不应被解释为当前文件仍存在：

| 项目 | 快照证据 |
|---|---|
| 目标 | `win/x64` |
| Worker | `ofs-rdp-worker.exe`，284,399 bytes |
| 运行时 DLL | 89 个，约 135,379,282 bytes staging 总大小 |
| 后端 | manifest 的 `backend: freerdp` |
| FreeRDP DLL | `libfreerdp-client3.dll`、`libfreerdp3.dll`、`libwinpr3.dll` |
| TLS DLL | `libcrypto-3-x64.dll`、`libssl-3-x64.dll` |
| 许可证文件 | `freerdp.txt`、`libjpeg-turbo.txt`、`libpng.txt`、`openssl.txt`、`zlib.txt` |
| 缺失 | 其余传递 DLL 的许可证集合、SBOM、CVE 报告、签名清单和最终哈希清单 |

历史 `rdp-worker-runtime.json` 只记录平台、架构、后端、运行时文件名和许可证文件名，没有依赖包版本、来源 URL、包校验和、构建提交、编译器版本或签名信息。

### 2.3 构建和 gate 证据边界

`scripts/buildRdpWorker.mjs`：

- 通过 `pkg-config` 的 `freerdp3`/`freerdp-client3` 或 CMake/vcpkg 查找 FreeRDP；本次 CMake cache 显示使用 `C:/msys64/ucrt64/bin/pkg-config.exe` 和 `FREERDP3`。
- CMake cache 和 `pkg-config --modversion` 均显示 FreeRDP core/client `3.30.0`；`libwinpr3.dll` 由同一 FreeRDP 包提供。
- Windows runtime 复制会从构建目录和发现的 vcpkg/MSYS2 prefix 复制 DLL；若 `ldd` 不可用，脚本保留 broad-copy fallback。这能产生可运行目录，但不能证明复制集合是最小且完整的依赖闭包。
- `copyKnownLicenseFiles()` 只枚举 `freerdp`、`winpr`、`openssl`、`zlib`、`libjpeg-turbo`、`libpng`、`openh264` 七个名称，并且每个名称只选一个候选许可证文件。它不会按实际 DLL 依赖闭包收集全部包的许可证和附加版权/专利声明。

`scripts/checkRdpWorkerPackage.mjs`：

- 检查 Worker、manifest、notice、manifest 引用的文件存在性，以及应用资源中的文件 SHA-256 一致性。
- `--require-freerdp` 只要求 manifest 声明 FreeRDP、运行时文件名含 FreeRDP/WinPR，并在可运行平台执行 Worker self-test。
- 合规相关的最低门槛只是 `manifest.licenseFiles.length > 0`，没有检查每个 DLL 所属包、许可证覆盖率、许可证文本正确性、GPL/LGPL 组合、SBOM、CVE、代码签名或签名链。因此历史 package gate 即使为 `OK`，也不是法律合规通过。

## 3. 依赖版本、来源和许可证证据

下表来自历史 staging DLL 名称与本机 MSYS2 UCRT64 pacman 文件记录的匹配。包版本是 `pacman` 本地记录中的版本，许可证是其 `%LICENSE%` 字段；`custom`、`GPL`、`LGPL` 等值仍需以包内完整文本和上游声明完成法律复核。

| 运行时 DLL 或 DLL 组 | MSYS2 包版本 | 包许可证字段 | 来源证据 |
|---|---|---|---|
| `libfreerdp-client3.dll`, `libfreerdp3.dll`, `libwinpr3.dll` | `mingw-w64-ucrt-x86_64-freerdp 3.30.0-2` | Apache-2.0 | pacman local；`https://www.freerdp.com/`；包内 `share/licenses/freerdp/LICENSE` |
| `libcrypto-3-x64.dll`, `libssl-3-x64.dll` | `mingw-w64-ucrt-x86_64-openssl 3.6.4-1` | Apache-2.0 | pacman local；`https://openssl-library.org`；包内 OpenSSL LICENSE |
| `zlib1.dll` | `mingw-w64-ucrt-x86_64-zlib 1.3.2-2` | Zlib | pacman local；`https://www.zlib.net/`；包内 zlib LICENSE |
| `avcodec-63.dll`, `avutil-61.dll`, `swresample-7.dll`, `swscale-10.dll` | `mingw-w64-ucrt-x86_64-ffmpeg 9.0.1-3` | GPL-3.0-or-later | pacman local；`https://ffmpeg.org/`；包归属、配置选项和 GPL 影响未完成复核 |
| `libaom.dll` | `aom 3.15.0-1` | BSD-2-Clause | pacman local；MSYS2 package archive and signature present |
| `libdav1d-7.dll` | `dav1d 1.5.4-1` | BSD-2-Clause | pacman local；包内 COPYING/PATENTS 可见 |
| `libjxl*.dll` | `libjxl 0.12.0-1` | BSD-3-Clause | pacman local；上游版权集合未复制到 staging |
| `libopenjp2-7.dll` | `openjpeg2 2.5.4-2` | BSD-2-Clause | pacman local；包内许可证目录可见 |
| `libopus-0.dll` | `opus 1.6.1-1` | BSD-3-Clause | pacman local；包内 COPYING 未复制 |
| `libvpx-1.dll` | `libvpx 1.16.0-1` | BSD-3-Clause | pacman local；包内版权文本未复制 |
| `libwebp-7.dll`, `libwebpmux-3.dll`, `libsharpyuv-0.dll` | `libwebp 1.6.0-1` | BSD-3-Clause | pacman local；包内 COPYING 未复制 |
| `librav1e.dll` | `rav1e 0.8.1-1` | BSD-2-Clause | pacman local；最终 staging 许可证缺失 |
| `libSvtAv1Enc-4.dll` | `svt-av1 4.2.0-1` | BSD-3-Clause-Clear | pacman local；最终 staging 许可证缺失 |
| `libx264-165.dll` | `libx264 0.165.r3222.b35605a-3` | custom | pacman local；需保留上游 x264 条款 |
| `libx265-217.dll` | `x265 4.3-1` | GPL | pacman local；需单独评估 GPL 触发和发行义务 |
| `xvidcore.dll` | `xvidcore 1.3.7-5` | GPL | pacman local；最终 staging 许可证缺失 |
| `libopencore-amrnb-0.dll`, `libopencore-amrwb-0.dll` | `opencore-amr 0.1.6-1` | Apache | pacman local；最终 staging 许可证缺失 |
| `libtheora*.dll` | `libtheora 1.2.0-1` | BSD-3-Clause | pacman local；最终 staging 许可证缺失 |
| `libvorbis*.dll` | `libvorbis 1.3.7-3` | custom | pacman local；最终 staging 许可证缺失 |
| `libmp3lame-0.dll` | `lame 3.100-3` | LGPL | pacman local；最终 staging 许可证缺失 |
| `libgsm.dll` | `gsm 1.0.24-1` | custom | pacman local；最终 staging 许可证缺失 |
| `libspeex-1.dll` | `speex 1.2.1-1` | BSD | pacman local；最终 staging 许可证缺失 |
| `liblc3-1.dll` | `liblc3 1.1.3-1` | Apache-2.0 | pacman local；最终 staging 许可证缺失 |
| `libsoxr.dll` | `libsoxr 0.1.3-5` | LGPL | pacman local；最终 staging 许可证缺失 |
| `libvpl-2.dll` | `libvpl 2.17.0-1` | MIT | pacman local；最终 staging 许可证缺失 |
| `libva*.dll` | `libva 2.24.1-1` | MIT | pacman local；最终 staging 许可证缺失 |
| `libzvbi-0.dll` | `zvbi 0.2.44-2` | GPL-2.0-or-later AND BSD-2-Clause AND LGPL-2.1-or-later AND MIT | pacman local；多许可证条款未复制 |
| `libogg-0.dll` | `libogg 1.3.6-1` | BSD-3-Clause | pacman local；最终 staging 许可证缺失 |
| `libjpeg-8.dll` | `libjpeg-turbo 3.2.0-1` | custom:BSD-like | pacman local；历史 staging 有 `libjpeg-turbo.txt` |
| `libpng16-16.dll` | `libpng 1.6.58-1` | custom | pacman local；历史 staging 有 `libpng.txt` |
| `libtiff-6.dll` | `libtiff 4.7.2-1` | MIT | pacman local；最终 staging 许可证缺失 |
| `libaom.dll` | `aom 3.15.0-1` | BSD-2-Clause | pacman local；PATENTS 未进入历史 staging |
| `libcairo*.dll` | `cairo 1.18.4-4` | LGPL-2.1-or-later OR MPL-1.1 | pacman local；包内包含多个 COPYING 文件 |
| `libglib*.dll`, `libgio-2.0-0.dll`, `libgobject*.dll` | `glib2 2.88.3-1` | LGPL-2.1-or-later | pacman local；最终 staging 许可证缺失 |
| `libgdk_pixbuf-2.0-0.dll` | `gdk-pixbuf2 2.44.7-1` | LGPL-2.1-or-later | pacman local；最终 staging 许可证缺失 |
| `libpango*.dll` | `pango 1.58.2-1` | LGPL-2.1 | pacman local；最终 staging 许可证缺失 |
| `libfreetype-6.dll` | `freetype 2.14.3-1` | GPL-2.0-or-later OR FTL | pacman local；必须随发行物保留适用条款 |
| `libfontconfig-1.dll` | `fontconfig 2.18.3-1` | custom | pacman local；最终 staging 许可证缺失 |
| `libharfbuzz-0.dll` | `harfbuzz 14.4.0-1` | MIT | pacman local；最终 staging 许可证缺失 |
| `libgraphite2.dll` | `graphite2 1.3.15-1` | LGPL-2.1-or-later | pacman local；最终 staging 许可证缺失 |
| `libfribidi-0.dll` | `fribidi 1.0.16-1` | LGPL-2.1-or-later | pacman local；最终 staging 许可证缺失 |
| `libthai-0.dll` | `libthai 0.1.30-1` | LGPL-2.1-or-later | pacman local；最终 staging 许可证缺失 |
| `libdatrie-1.dll` | `libdatrie 0.2.14-1` | LGPL | pacman local；最终 staging 许可证缺失 |
| `libpcre2-8-0.dll` | `pcre2 10.47-1` | BSD-3-Clause | pacman local；最终 staging 许可证缺失 |
| `libxml2-16.dll` | `libxml2 2.15.3-1` | MIT | pacman local；最终 staging 许可证缺失 |
| `libexpat-1.dll` | `expat 2.8.3-1` | MIT | pacman local；最终 staging 许可证缺失 |
| `libffi-8.dll` | `libffi 3.8.0-1` | MIT | pacman local；最终 staging 许可证缺失 |
| `libiconv-2.dll` | `libiconv 1.19-1` | LGPL-2.1-or-later; documentation GPL-3.0-or-later | pacman local；文档许可证需单独保留 |
| `libintl-8.dll` | `gettext-runtime 1.0-1` | GPL-3.0-or-later AND LGPL-2.1-or-later | pacman local；最终 staging 许可证缺失 |
| `libbrotli*.dll` | `brotli 1.2.0-1` | MIT | pacman local；最终 staging 许可证缺失 |
| `libbz2-1.dll` | `bzip2 1.0.8-4` | custom | pacman local；最终 staging 许可证缺失 |
| `libdeflate.dll` | `libdeflate 1.26-1` | MIT | pacman local；最终 staging 许可证缺失 |
| `liblzma-5.dll` | `xz 5.8.3-1` | 0BSD AND LGPL-2.1-or-later AND GPL-2.0-or-later | pacman local；多许可证条款未复制 |
| `libzstd.dll` | `zstd 1.5.7-2` | BSD-3-Clause OR GPL-2.0-or-later | pacman local；最终 staging 许可证缺失 |
| `libjbig-0.dll` | `jbigkit 2.1-6` | GPL-2.0 | pacman local；最终 staging 许可证缺失 |
| `libLerc.dll` | `lerc 4.1.1-1` | Apache-2.0 | pacman local；最终 staging 许可证缺失 |
| `liblcms2-2.dll` | `lcms2 2.19.1-1` | MIT AND GPL-3.0-or-later | pacman local；需审查实际链接/使用范围 |
| `libhwy.dll` | `highway 1.4.0-3` | Apache-2.0 | pacman local；最终 staging 许可证缺失 |
| `libgcc_s_seh-1.dll`, `libgomp-1.dll`, `libstdc++-6.dll` | `gcc-libs 16.2.0-3` | GPL-3.0-or-later WITH GCC-exception-3.1 AND LGPL-2.1-or-later | pacman local；Runtime Exception 条款需随发行物核对 |
| `libwinpthread-1.dll` | `libwinpthread 14.0.0.r302.gd7f3c5201-1` | MIT AND BSD-3-Clause-Clear | pacman local；最终 staging 许可证缺失 |

注：表中 `libaom.dll` 出现一次即可；它在历史 DLL 清单中只有一个文件。表格覆盖的是历史 89 个 DLL 对应的 62 个唯一包，而不是声称这些包当前仍在 staging 中。

## 4. 已验证、启发式和未验证

### 已验证到的事实

- MSYS2 pacman 本地记录存在 FreeRDP `3.30.0-2`、OpenSSL `3.6.4-1`、FFmpeg `9.0.1-3`、zlib `1.3.2-2`、libjpeg-turbo `3.2.0-1`、libpng `1.6.58-1` 等版本记录。
- FreeRDP 和 OpenSSL 关键包记录显示 `Validated By: SHA-256 Sum Signature`；关键包的 `.pkg.tar.zst` 和 `.sig` 文件在本机 pacman cache 中可见。
- CMake cache 使用 `C:/msys64/ucrt64/bin/pkg-config.exe`，并记录 `freerdp3`/`freerdp-client3` 版本 `3.30.0`、`libfreerdp3.dll`/`libfreerdp-client3.dll`/`libwinpr3.dll` 导入库路径。
- 历史 staging manifest、notice 和 5 个复制的许可证文件确实被读取过。

### 仅为启发式或不足以放行的证据

- DLL 文件名、Windows VersionInfo 和 `pkg-config` 版本不能替代逐文件 SHA-256、包归属、上游源码提交和可复现构建记录。
- MSYS2 包数据库能提供构建环境的包版本和许可证字段，但不能证明历史 staging 中每个 DLL 字节都来自该包，尤其当前 staging 已被覆盖。
- `ldd`/broad-copy 复制策略和 manifest 的文件名列表不能替代最终依赖闭包扫描；还需要解析每个 DLL 的导入表并排除系统 DLL。
- 5 个许可证文件和 package gate 的 `licenseFiles.length > 0` 不能覆盖 89 个 DLL 的许可证、版权、专利和附加通知。
- Worker self-test 只验证协议能力，不验证法律许可、漏洞状态、签名或供应链完整性。

## 5. 合规清单

状态值：`VERIFIED` 仅表示本报告明确验证的事实；`NEEDS_WORK` 表示代码/构建流程缺口；`BLOCKED_EXTERNAL_ENV` 表示需要外部服务、凭据或发布环境。

| ID | 检查项 | 状态 | 关闭条件 |
|---|---|---|---|
| LC-01 | 最终分发物逐文件 inventory、DLL 导入闭包和 SHA-256 | `BLOCKED_EXTERNAL_ENV` | 重新生成最终 Windows x64 staging，保存 Worker、每个 DLL、manifest、notice、许可证的哈希清单 |
| LC-02 | FreeRDP/WinPR 版本和来源 | `VERIFIED`（构建环境） | 将 package archive、包签名、上游提交/构建日志绑定到最终 artifact digest |
| LC-03 | OpenSSL 版本和来源 | `VERIFIED`（构建环境） | 将 `3.6.4-1` 与最终 `libcrypto`/`libssl` 哈希绑定，并复核发布策略 |
| LC-04 | FFmpeg 与全部编解码器版本、许可证 | `NEEDS_WORK` | 补齐 FFmpeg 配置、所有实际 DLL 包记录、版权/专利/许可证文本和 GPL 法律结论 |
| LC-05 | 传递 DLL 许可证覆盖率 | `NEEDS_WORK` | 每个实际 DLL 至少映射一个包、版本和完整许可证/版权通知；多许可证包保留全部适用文本 |
| LC-06 | SPDX 或 CycloneDX SBOM | `BLOCKED_EXTERNAL_ENV` | 提供 SBOM 工具或固定离线生成环境，产出带 artifact digest 的 SPDX/CycloneDX 文件并复核 |
| LC-07 | CVE/安全公告扫描 | `BLOCKED_EXTERNAL_ENV` | 提供固定日期的 NVD/OSV/MSYS2 数据库或扫描服务，记录组件版本、扫描时间、结果和例外批准 |
| LC-08 | GPL/LGPL/专利义务审查 | `BLOCKED_EXTERNAL_ENV` | 由法律责任人根据最终链接方式、发行方式和目标市场批准义务矩阵 |
| LC-09 | Windows Worker 签名和时间戳 | `BLOCKED_EXTERNAL_ENV` | 发布证书、可信链、签名日志、时间戳和篡改后失败证据 |
| LC-10 | macOS Worker/app 签名、公证和 stapling | `BLOCKED_EXTERNAL_ENV` | macOS 构建环境、Developer ID 凭据、公证日志和干净机验证；未完成前不得宣称 macOS 原生 RDP 可发布 |
| LC-11 | package gate 的合规能力 | `NEEDS_WORK` | gate 检查完整依赖/license manifest、SBOM/CVE/signature artifacts，而非只检查任意许可证文件存在 |
| LC-12 | 当前 staging 可复核性 | `BLOCKED_EXTERNAL_ENV` | 停止并发覆盖，保留不可变 staging/archive；当前目录为 `linux/x64` 缺省 marker，不能签核 Windows x64 |

## 6. 必须补齐的交付物

1. 由最终构建产物生成的逐文件清单：路径、目标架构、SHA-256、PE/动态库导入、所属包、包版本、来源 URL、构建日期。
2. 62 个包对应的完整许可证、版权、NOTICE、PATENTS 和必要的源码获取方式；不得只复制一个通用 LICENSE 文件。
3. 带最终 artifact digest 的 SPDX 或 CycloneDX SBOM，并把生成工具版本、MSYS2 snapshot、pacman 包签名验证结果纳入构建记录。
4. 固定数据源和时间点的 CVE/安全公告扫描，包含误报、不可修复漏洞、例外审批和重新扫描日期。
5. Windows 签名与时间戳证据；若启用 macOS/Linux 原生 Worker，还需分别完成对应平台签名、公证或包签名要求。
6. 法律责任人对 FFmpeg GPL、x265 GPL、xvidcore GPL、jbigkit GPL、gettext、xz、zstd、zvbi 及 LGPL/多许可证依赖作出书面结论。

## 7. 初审结论

初审结论为：`BLOCKED_EXTERNAL_ENV / NOT_APPROVED`。

FreeRDP/WinPR、OpenSSL 和大量传递依赖的构建环境版本已有较强证据，但最终发布物不可复核，许可证集合明显不完整，SBOM/CVE/签名均无可验证证据。任何历史构建或 package gate 的成功只能作为工程构建证据，不能改变本合规结论。
