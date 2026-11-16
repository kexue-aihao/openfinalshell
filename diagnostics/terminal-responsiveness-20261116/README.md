# 原始验证证据

- acceptance-ui.json / acceptance-ui-heartbeat.txt：256 KiB SSH 接收窗口修复后的 600 秒 WinUI 验收。
- final-ui.json / final-ui-heartbeat.txt：复制取消与保留工作区修正后的 60 秒最终验证，含工作区重新挂载。
- final-600-ui.json / final-600-heartbeat.txt：最终应用代码完整 600 秒验收，P99=22.5 ms、max=365.7 ms、cleanup=43.7374 ms，无错误。
- app-build.txt：最后 Release x64 构建，0 警告 / 0 错误。
- core-tests.txt、terminal-tests.txt、ssh-tests.txt、native-probe.txt：契约断言、两组 250 万行解析压力及真实 SSH 哈希回归。
- baseline-ui.json / baseline-ui-heartbeat.txt：原始处理链加诊断兼容接口，60 秒。新增指标不存在的零值不是接收量。
- intermediate-ui.json / intermediate-ui-heartbeat.txt：窗口流控补丁之前的 600 秒运行，仅作中间证据。
- electron-reference.json：等效 ssh2/xterm 工具，非完整产品，计时口径与 WinUI 不同。
- background-read-stack.txt / acceptance-stack.txt：后台阻塞 Read 栈样例；没有复现或证明死锁。

完整方法、版本、限制和复现命令见 docs/terminal-responsiveness-20261116.md。
这些文件不含数据库、账户存储或生产主机数据。运行使用本地可控 SSH fixture。
