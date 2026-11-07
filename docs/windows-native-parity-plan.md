# WinUI 3 完整功能对齐执行记录

基线：Electron / Native Preview 0.30.34。用户确认完整对齐、沿用 Electron 工作流、WinUI 原生控件、隔离资源、分批本机验收。默认数据目录及现有安装不变，不使用生产凭据。

## 批次

1. 数据兼容与工作台：嵌套分组、未知字段保护、共享设置局部更新、代理语义、连接树/搜索/右键/归组、快速连接/最近会话、同屏终端/SFTP/监控/编辑器、选择性加密导入。
2. 终端与文件：终端配置/IME/菜单/历史，SFTP 多选/菜单/排序/目录跟随，传输并发/冲突/批量控制/打包/快速删除，Scintilla 查找替换/跳行/折叠/多文档/独立窗口及保存安全。
3. 运维工具：监控指标与趋势、采集生命周期、三种转发、命令库和 AI 全流程。
4. 平台完整性：全部设置/语言/快捷键、FinalShell 导入、LAN Sync、多窗口、引导/关于、RDP runtime 与能力、安装更新和失败恢复。

## 完成门槛

分别记录服务、入口、交互和验收。协议或 fixture 通过不能替代 UI 等价。Windows 11 x64 管理员环境与普通用户/其他架构分开记录。真实 Linux/RDP/AI/Android 资源缺失时标记外部阻塞。

Core/SSH 合同、native probe、x64 Release、NativeSmokeRunner、相关 Renderer 测试、typecheck、check:i18n；隔离 UI 验收含嵌套迁移、字段往返、右键目标、同屏会话保持、文件字节一致、编辑冲突和脏关闭、监控/转发。结果保存在 build/windows-native-acceptance/ 的独立目录。

## 本轮基线

- 2026-11-04：工作区仅存在既有未跟踪目录；不清理。
- 修改前 Core：113 项通过。
- 已安装原生版为 0.30.34，当前只有一条旧 smoke 连接；不自动删除。
- 已确认分组无 parentId、设置整记录替换、代理 saved/custom 不一致、终端/SFTP/监控分离标签、工作台缺少树和搜索。
- 各批次进度和证据见 windows-native-parity-status.md；完成前维持预览身份，不自动发版或覆盖安装。
