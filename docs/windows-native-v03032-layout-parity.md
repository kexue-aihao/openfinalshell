# WinUI 3 前端排版核对（v0.30.32）

本轮以 GitHub `v0.30.32` 标签的最后提交作为排版基线：

- tag peeled commit：`b345ffe4af41e8a15f1842c2ae6ad1b52e8ba8a8`
- 提交时间：2026-10-22 17:24:42 +0800
- subject：`test(sftp): detect the bsdtar emoji regression behaviorally`
- Electron 参考源码归档：`diagnostics/frontend-parity-v03032-20261107/electron-reference`

## 本轮前端修复

- 顶栏与标签页合并为 40px 原生标题栏；保留品牌区、原生 TabView、加号和系统 caption 区。
- Activity rail 调整为 48px；按钮 38px、间距 4px；AI 入口位置与 Electron 一致。
- 欢迎页恢复品牌图、标题、副标题、三张任务卡和最近会话；窄宽度按三列、两列、单列重排。
- 连接树搜索、新建连接、新建分组保持同一行；命令、转发、传输工具条改为原生 CommandBar 溢出布局。
- 设置改为 860px 居中模态，包含 Electron 的十个分类；字段标签列宽 180px。
- 新建/编辑连接改为 520px 右侧抽屉，主机和端口并排，高级与代理折叠；抽屉 Loaded 后再设置初始焦点。
- AI 助手改为 820px 模态，provider、目标 SSH、响应模式分行，输入区为多行文本框。
- 会话工作区保持终端在上、SFTP 在下（默认 40%）、监控在右；终端工具条悬浮于右上角。
- 浅色主题统一更新 XAML 与代码创建面板的画刷，避免文字变浅而背景仍为深色。
- SSH 标签页加入状态圆点、重命名/复制/重连/关闭菜单、双击重命名和中键关闭。

业务逻辑和协议实现没有在本轮修改；改动集中在 `windows/OpenFinalShell.App` 的布局、呈现和交互接线。

## 构建与验收

成功构建命令：

```powershell
dotnet publish windows/OpenFinalShell.App/OpenFinalShell.App.csproj `
  -c Release -p:Platform=x64 `
  -p:NativeAcceptanceName=OpenFinalShell.LayoutParity `
  -o build/windows-native-acceptance/layout-v03032-20261107/app-reviewed `
  --no-restore -v:minimal
```

验收程序：`build/windows-native-acceptance/layout-v03032-20261107/app-reviewed/OpenFinalShell.LayoutParity.exe`

已实际检查：浅色欢迎页、设置十分类、AI 模态、命令栏、右侧连接抽屉（取消不保存、主机/端口并排）、本机隔离 SSH fixture 的终端和 SFTP。证据文本保存在 `diagnostics/frontend-parity-v03032-20261107/uia-light-home.txt` 与 `uia-connection-drawer.txt`，构建日志为 `publish-reviewed.log`。

本机 fixture 的 SFTP 展示仍直接使用 Core 提供的值，因此 owner/group 是数字 UID/GID、权限显示为十进制；这属于数据呈现差异，没有为了排版改动 Core。真实 RDP 主机和真实 AI provider 未作为本轮验收条件。

## 后端保护核对

`backend-before.json` 记录的 238 个后端/共享/协议/测试文件中，除三个依赖锁文件外的 235 个业务源文件 SHA-256 均保持一致。三个 `packages.lock.json` 不属于业务逻辑，且当前 Git 工作区没有本轮对它们的差异；核对结果详见 `diagnostics/frontend-parity-v03032-20261107/verification.json`。本轮没有编辑 `src/main`、`src/preload`、`src/shared`、`native` 或 `windows/OpenFinalShell.Core*` 的业务实现。
