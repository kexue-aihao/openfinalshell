# Windows 原生自动更新器

原生 WinUI3 客户端使用架构专属、RSA 签名的 GitHub Release feed。应用会在窗口加载 10 秒后检查一次，随后每 6 小时检查；发现新版本会下载并验证安装包，最终安装仍需用户确认。

## 运行流程

1. 客户端读取 `https://github.com/kexue-aihao/openfinalshell/releases/latest/download/native-update-{arch}.json`。其中 `{arch}` 为 `x64`、`x86` 或 `arm64`。
2. 清单必须使用固定公钥验证，版本必须高于当前版本，架构必须与当前进程一致。
3. 安装包以流式方式写入更新目录并计算 SHA-256；整个文件不会读入内存。最大允许大小为 2 GiB。
4. 初始清单和安装包 URL、以及 HTTP 重定向后的最终 URL，都必须是 HTTPS 或本机 loopback HTTP。
5. 下载大小、SHA-256 和签名全部匹配后才进入 `Ready` 状态；启动安装器前会再次验证文件。
6. 存在 SSH 会话、传输、活动转发、未保存编辑器或 RDP 会话时阻止安装。用户确认后才启动安装器。
7. 用户确认后，安装器以 `/S /WAITPID=<旧进程ID>` 静默启动，持有旧进程句柄并在文件覆盖前等待其退出；安装成功后重新启动新版。
8. 安装目录默认为 `C:\Program Files\OpenFinalShell Native Preview`，与 `%LOCALAPPDATA%\OpenFinalShell.NativePreview` 数据目录分离。覆盖安装和卸载不删除连接、凭据、known hosts、分组或转发规则。

## Feed 格式

代码生成的三份清单分别命名为：

```text
native-update-x64.json
native-update-x86.json
native-update-arm64.json
```

每份清单的 `schemaVersion` 为 `1`，并包含 `version`、`channel`、`architecture`、`fileName`、`downloadUrl`、`sha256`、`signature`、`bytes`、`publishedAt` 和 `notesUrl`。签名原文固定为：

```text
{version}\n{channel}\n{sha256}\n
```

签名算法为 RSA PKCS#1 v1.5、SHA-256。应用内嵌公钥位于 `windows/OpenFinalShell.Core/UpdatePublicKey.pem`，私钥不得进入 Git、构建日志或应用数据。

本机测试可以用 `OFS_NATIVE_UPDATE_FEED` 指向 HTTPS feed 或 loopback HTTP。

## GitHub Release 发布

`desktop-release` 工作流新增 `build-native` 矩阵任务，构建 x64、x86 和 ARM64 自包含安装包。tag 发布时还要求 GitHub Actions Secret：

```text
NATIVE_UPDATE_PRIVATE_KEY_B64
```

Secret 内容是私钥 PEM 文件的无换行 Base64，不是 PEM 文本本身。生成值时可在 PowerShell 中执行下列命令，并将输出值仅写入 GitHub Secret：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('private-key.pem'))
```

`build-native` 会：

- 下载并校验固定版本的 LLVM、libvterm、Scintilla 和 Lexilla 依赖。
- 编译终端组件；x64 额外编译 Scintilla/Lexilla。
- 发布版本化自包含应用并生成版本化 NSIS 安装器。
- 对每个安装包计算摘要，验证私钥与固定公钥匹配，再生成签名清单。
- 将安装包和清单作为独立 artifact 上传到合并后的同一 Release。
- 清理旧桌面资产时保留 `OpenFinalShell-NativePreview-*` 和 `native-update-*.json`。

本地构建命令：

```powershell
.\scripts\prepareNativeDependencies.ps1
.\scripts\buildNativeTerminal.ps1 -Architecture x64
.\scripts\buildNativeEditor.ps1 -Architecture x64
.\windows\publish-native.ps1 -Architecture x64 -Version 0.30.32 -Publish
.\windows\installer\build-native-installer.ps1 -Architecture x64 -Version 0.30.32
```

隔离目录验收时，`publish-native.ps1` 和 `build-native-installer.ps1` 均支持显式 `-OutputDirectory`；安装器构建器还支持 `-InputDirectory`。

## 当前边界

- 更新只提供完整安装包，没有差分下载。
- 安装需要用户确认，不会静默关闭活动工作。
- NSIS 安装器尚未做 Authenticode 代码签名；RSA 清单签名负责更新内容可信性，SmartScreen 发布者信誉仍需要后续证书接入。
- 自动回滚、真实 GitHub Release 升级和普通用户/其他架构真机验收仍需发布候选版本验证。
- 原生版仍保持 Preview 身份，Electron 仍是当前正式 Windows 客户端。
