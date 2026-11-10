import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../src/shared/locales', import.meta.url)))
const english = {
  common: { import: 'Import', export: 'Export', imported: 'Import completed', exported: 'Export completed',
    save: 'Save', saved: 'Saved', cancel: 'Cancel', continue: 'Continue', ok: 'OK', passphrase: 'Export passphrase', overwrite: 'Overwrite', duplicate: 'Duplicate', duplicateConnection: 'Duplicate connection', skip: 'Skip', edit: 'Edit', delete: 'Delete', deleted: 'Deleted', reconnect: 'Reconnect', pause: 'Pause', resume: 'Resume', cancelTransfer: 'Cancel transfer', retry: 'Retry', clearFinished: 'Clear finished', refresh: 'Refresh' },
  newConnection: 'New connection', name: 'Name', host: 'Host', port: 'Port', username: 'Username', password: 'Password', authMethod: 'Authentication', charset: 'Terminal encoding', termType: 'Terminal type', startupCommand: 'Startup command', keepAlive: 'Keep-alive interval (ms)', readyTimeout: 'Connection timeout (ms)', productionPlaceholder: 'Production', hostPlaceholder: 'example.com', usernamePlaceholder: 'root', connected: 'Connected', openSftp: 'Open SFTP', themeStatus: 'Theme: {{value}}', importSummary: '{{profiles}} profiles · {{secrets}} secrets',
  validationFailed: 'Enter a name, host and username.', imported: 'Data imported.', exported: 'Data exported.', protocol: 'Protocol', group: 'Group',
  keys: { manage: 'Saved keys', add: 'Add key', savedKey: 'Saved private key' },
  proxies: { manage: 'Saved proxies', add: 'Add proxy', type: 'Proxy type', savedProxy: 'Saved proxy', direct: 'Direct' },
  knownHosts: { manage: 'Known hosts', revoke: 'Revoke trust' },
  groups: { title: 'Connection groups', new: 'New group', moveUp: 'Move up', moveDown: 'Move down' },
  connections: { sort: 'Sort connections', sortName: 'Name', sortHost: 'Host', sortRecent: 'Recently connected', grouping: 'Group connections', groupNone: 'No grouping', groupBy: 'By group' },
  forward: { new: 'New forwarding rule', connection: 'Connection', type: 'Type', bindAddress: 'Bind address', bindPort: 'Bind port', destinationHost: 'Destination host', destinationPort: 'Destination port', autoStart: 'Start automatically', start: 'Start', stop: 'Stop', active: 'Forwarding active', stopped: 'Forwarding stopped', noConnections: 'Create a connection first.' },
  lansync: { title: 'LAN Sync', startReceive: 'Start receiving', stopReceive: 'Stop receiving', scan: 'Scan devices', send: 'Send', cancel: 'Cancel', apply: 'Apply incoming data', reject: 'Reject', code: 'Pairing code', host: 'Host', port: 'Port', includeSecrets: 'Include secrets', sent: 'Sync sent', incoming: 'Incoming sync from {{device}} · {{profiles}} profiles · {{secrets}} secrets · {{missingKeys}} missing keys' },
  ai: { test: 'Test provider', discover: 'Discover models', capability: 'Test image capability', image: 'Attach image', configure: 'Provider settings', send: 'Send', cancel: 'Cancel request', clear: 'Clear conversation', message: 'Message', name: 'Provider name', baseUrl: 'API base URL', model: 'Model', token: 'API token', enabled: 'Enabled', discovered: 'Discovered {{count}} models' },
  commands: { newGroup: 'New group', new: 'New command', command: 'Command', autoEnter: 'Press Enter after sending', send: 'Send to session', clearHistory: 'Clear history', clearConfirm: 'Clear command history?', selectSession: 'Open a session first.' },
  openMonitor: 'Open monitor', monitor: { title: 'Monitor', state: 'Monitor', failed: 'Monitor failed', cpu: 'CPU', memory: 'Memory', network: 'Network', load: 'Load' },
  portTraffic: { title: 'Port traffic', state: 'Port traffic' },
  sftp: { refresh: 'Refresh', upload: 'Upload', uploadFolder: 'Upload folder', download: 'Download', newFolder: 'New folder', newFile: 'New file', delete: 'Delete', up: 'Up', rename: 'Rename', chmod: 'Permissions (octal)', conflictTitle: 'Remote file already exists', overwrite: 'Overwrite remote file', entries: 'entries', files: 'files', symlinkWarning: 'Symbolic links are counted but are not traversed.' },
  editor: { save: 'Save', saved: 'Saved', reload: 'Reload', modified: 'Modified', automationName: 'Remote editor', remoteChangedTitle: 'Remote file changed', remoteChanged: 'The remote file changed while it was open. Overwrite it?', overwrite: 'Overwrite', shrinkTitle: 'File became much smaller', shrinkMessage: 'The replacement is substantially smaller than the original. Continue?', allowShrink: 'Allow smaller file', saveFailed: 'Save failed', unsavedTitle: 'Unsaved changes', unsavedMessage: 'Save changes before closing?', saveBeforeClose: 'Save', discard: 'Discard' },
  settings: { resetTrust: 'Reset host trust', transparency: 'Transparency preference updated' },
  rdp: { copyRemoteClipboard: 'Copy remote clipboard', pasteLocalClipboard: 'Paste local clipboard', pasteLocalFiles: 'Paste local files', downloadRemoteFiles: 'Download remote files', fileClipboard: 'File clipboard', audio: 'Audio', clipboardCopied: 'Remote clipboard copied', frameError: 'RDP frame error', systemFallback: 'Use system Remote Desktop' },
  hostKeyTitle: 'Confirm host key',
  errors: { transportUnavailable: 'This transport is not available in the native edition.', charsetUnavailable: 'This terminal encoding is not available in the native edition.', privateKeyMissing: 'The private key file is missing.', agentUnavailable: 'SSH Agent authentication is not available in the native edition.', invalidProxy: 'The proxy configuration is invalid.', invalidForward: 'The forwarding rule is invalid.', databaseVersion: 'This native database was created by a newer version.', referenceInUse: 'Cannot delete this item because it is used by: {{names}}', revisionConflict: 'This configuration changed elsewhere. Reload it and try again.' }
}
const chinese = { common: { import: '导入', export: '导出', imported: '导入完成', exported: '导出完成', save: '保存', saved: '已保存', cancel: '取消', continue: '继续', passphrase: '导出口令', overwrite: '覆盖', duplicate: '复制导入', duplicateConnection: '复制连接', skip: '跳过', edit: '编辑', delete: '删除', deleted: '已删除', reconnect: '重连', pause: '暂停', resume: '继续', cancelTransfer: '取消传输', retry: '重试', clearFinished: '清除已完成', refresh: '刷新' }, newConnection: '新建连接', name: '名称', host: '主机', port: '端口', username: '用户名', password: '密码', authMethod: '认证方式', charset: '终端编码', termType: '终端类型', startupCommand: '启动命令', keepAlive: '保活间隔（毫秒）', readyTimeout: '连接超时（毫秒）', productionPlaceholder: '生产环境', hostPlaceholder: 'example.com', connected: '已连接', openSftp: '打开 SFTP', openMonitor: '打开监控', themeStatus: '主题：{{value}}', importSummary: '{{profiles}} 个连接 · {{secrets}} 个密码', validationFailed: '请输入名称、主机和用户名。', protocol: '协议', group: '分组', keys: { manage: '已保存私钥', add: '添加私钥', savedKey: '已保存私钥' }, proxies: { manage: '已保存代理', add: '添加代理', type: '代理类型', savedProxy: '已保存代理', direct: '直连' }, knownHosts: { manage: '已知主机', revoke: '撤销信任' }, groups: { title: '连接分组', new: '新建分组' }, forward: { new: '新建转发规则', connection: '连接', type: '类型', bindAddress: '绑定地址', bindPort: '绑定端口', destinationHost: '目标主机', destinationPort: '目标端口', autoStart: '自动启动', start: '启动', stop: '停止', active: '转发已启动', stopped: '转发已停止', noConnections: '请先创建连接。' }, lansync: { title: '局域网同步', startReceive: '开始接收', stopReceive: '停止接收', scan: '扫描设备', send: '发送', cancel: '取消', apply: '应用接收数据', reject: '拒绝', code: '配对码', host: '主机', port: '端口', includeSecrets: '包含敏感信息', sent: '同步已发送', incoming: '来自 {{device}} 的同步 · {{profiles}} 个连接 · {{secrets}} 个敏感项 · {{missingKeys}} 个私钥缺失' }, imported: '数据已导入。', exported: '数据已导出。', settings: { resetTrust: '重置主机信任', transparency: '透明度偏好已更新' }, sftp: { refresh: '刷新', upload: '上传', download: '下载', newFolder: '新建目录', delete: '删除', up: '上级目录', rename: '重命名', chmod: '权限（八进制）', conflictTitle: '远程文件已存在', overwrite: '覆盖远程文件' }, rdp: { downloadRemoteFiles: '下载远程文件' }, hostKeyTitle: '确认主机密钥', errors: { transportUnavailable: '原生版暂不支持此传输协议。', charsetUnavailable: '原生版暂不支持此终端编码。', privateKeyMissing: '私钥文件不存在。', agentUnavailable: '原生版暂不支持 SSH Agent 认证。', invalidProxy: '代理配置无效。', invalidForward: '转发规则无效。', databaseVersion: '原生数据库由更新版本创建。', referenceInUse: '无法删除，以下项目仍在使用：{{names}}' } }
chinese.ai = { test: '测试服务', discover: '发现模型', capability: '测试图像能力', image: '附加图像', configure: '服务设置', send: '发送', cancel: '取消请求', clear: '清空对话', message: '输入消息', name: '服务名称', baseUrl: 'API 基础地址', model: '模型', token: 'API Token', enabled: '启用', discovered: '已发现 {{count}} 个模型' }
chinese.commands = { newGroup: '新建分组', new: '新建命令', command: '命令', autoEnter: '发送后自动回车', send: '发送到会话', clearHistory: '清空历史', clearConfirm: '确认清空命令历史？', selectSession: '请先打开一个会话。' }
chinese.openMonitor = '打开监控'
chinese.monitor = { title: '监控', state: '监控', failed: '监控失败', cpu: 'CPU', memory: '内存', network: '网络', load: '负载' }
chinese.portTraffic = { title: '端口流量', state: '端口流量' }
chinese.common.ok = '确定'
chinese.sftp.newFile = '新建文件'
chinese.sftp.uploadFolder = '上传目录'
chinese.sftp.entries = '项'
chinese.sftp.files = '文件'
chinese.sftp.symlinkWarning = '符号链接已计入统计，但不会递归跟随。'
chinese.editor = { save: '保存', saved: '已保存', reload: '重新加载', modified: '已修改', automationName: '远程编辑器', remoteChangedTitle: '远程文件已变化', remoteChanged: '文件打开期间远端内容已变化，是否覆盖？', overwrite: '覆盖', shrinkTitle: '文件明显变小', shrinkMessage: '新内容明显小于原文件，是否继续？', allowShrink: '允许保存较小文件', saveFailed: '保存失败', unsavedTitle: '有未保存的修改', unsavedMessage: '关闭前保存修改？', saveBeforeClose: '保存', discard: '放弃修改' }
chinese.rdp = { copyRemoteClipboard: '复制远程剪贴板', pasteLocalClipboard: '粘贴本地剪贴板', pasteLocalFiles: '粘贴本地文件', downloadRemoteFiles: '下载远程文件', fileClipboard: '文件剪贴板', audio: '音频', clipboardCopied: '已复制远程剪贴板', frameError: 'RDP 画面错误', systemFallback: '使用系统远程桌面' }
chinese.usernamePlaceholder = 'root'
chinese.connections = { sort: '连接排序', sortName: '名称', sortHost: '主机', sortRecent: '最近连接', grouping: '连接分组', groupNone: '不分组', groupBy: '按分组' }
chinese.groups.moveUp = '上移'
chinese.groups.moveDown = '下移'
chinese.errors.revisionConflict = '此配置已在其他位置修改，请重新加载后重试。'

for (const file of (await readdir(root)).filter(x => x.endsWith('.json'))) {
  const path = resolve(root, file); const text = await readFile(path, 'utf8'); const data = JSON.parse(text)
  data.native = file === 'zh-CN.json' ? chinese : english
  await writeFile(path, JSON.stringify(data, null, 2) + '\n')
}
