# Windows native migration status

更新日期：2026-11-03。范围：Windows 11 Pro Build 26300 x64，管理员会话，本机 fixture。

| 领域 | 状态 | 当前实现与验收 |
| --- | --- | --- |
| WinUI shell | 代码完成，本机 x64 通过 | 标准 `dotnet publish -o` 包含 XBF/PRI；导航、设置、连接编辑和平台主题可启动 |
| SSH Agent | 代码完成，协议通过 | SSH_AUTH_SOCK、Windows OpenSSH Agent、Pageant 身份和签名帧测试通过 |
| 会话与跳板机 | 代码完成，fixture 通过 | 密码/KBI、独立 host-key、单跳、缺失/嵌套引用错误；真实服务器矩阵待测 |
| Terminal | 代码完成，本机 x64 部分通过 | 正常尺寸、命令/Unicode、五种编码、标签切换持久、输出背压；IME/Narrator/DPI/多屏待测 |
| SFTP | 代码完成，fixture 通过 | REALPATH、缺失判断、上传下载、精确 RENAME、原子编辑保存和回滚通过 |
| Transfer queue | 代码完成，合同与 fixture 通过 | 文件/目录父子任务、进度、慢速暂停/恢复、失败重试/取消和字节校验通过；长目录长时 UI 待测 |
| Scintilla/Lexilla | 代码完成，本机 x64 部分通过 | HWND、Lexilla 语言、编辑焦点、保存、冲突和脏关闭通过；多文档/独立窗口和大文件性能待测 |
| Monitoring | 代码完成，fixture UI 通过 | 逐核 CPU、内存、网络、磁盘容量/I-O、Top 进程、socket/TCP、延迟、状态/错误 |
| Forwarding | 代码完成，协议通过 | local/remote/dynamic 实际回环、活动连接、双向字节、停止清理；UI basic pass |
| RDP | 外部阻断 | FreeRDP runtime DLL 缺失，真实服务、音频和拖放未验收 |
| AI | 部分实现 | Provider/token、流式、多模态和限制合同通过；真实服务未测 |
| Command library/history | 部分实现 | 原生 CRUD、排序、发送与会话历史；跨端共享回归未测 |
| LAN Sync | 部分实现 | 本机配对/加密交换通过；Electron/Android 和真实网络未测 |
| FinalShell import | 部分实现 | 通用导出/事务导入通过；FinalShell 专用扫描未完成 |
| Multi-window | 部分实现 | 单实例写者、聚焦和 CAS 通过；独立编辑器窗口未完成 |
| Update/install | 部分实现 | 校验门控和中断记录合同通过；签名、UI、覆盖升级和回滚未测 |
| Accessibility/platform | 部分实现 | UIA 名称/实时区域已接入；完整键盘、Narrator、高对比度、DPI 和 Windows 10 未测 |
| Auxiliary pages | 未开始 | Android LAN Sync、引导、捐赠等未纳入本轮核心闭环 |

当前不能把 Windows 原生版标为正式替换。阶段完成条件是矩阵中所有 `部分实现`、外部阻塞和平台缺口关闭；Electron 继续作为正式 Windows 客户端。