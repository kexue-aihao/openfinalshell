/**
 * 内置编辑器的**纯策略**：一个远端路径该用哪种语法着色。
 *
 * 单独成文件而不是塞在组件里，是因为它是这一片里唯一"有大量分支、且判据全是经验"的
 * 部分 —— 它值得一张用例表，而组件不值得。这里不 import 任何 CodeMirror 东西
 * （连类型都不 import）：语言 id → 实际扩展的映射在 cmSetup.ts，
 * 于是这份表可以在 node 环境下单测，不需要 DOM。
 */

export type LanguageId =
  | 'plain'
  | 'json'
  | 'yaml'
  | 'shell'
  | 'nginx'
  | 'properties'
  | 'toml'
  | 'dockerfile'
  | 'diff'
  | 'lua'
  | 'perl'
  | 'python'
  | 'javascript'
  | 'xml'
  | 'html'
  | 'sql'
  | 'css'

/** 状态栏上显示的名字。语言名是专有名词，不进 i18n（16 个键 × 2 份纯噪声） */
const LABELS: Record<LanguageId, string> = {
  plain: '纯文本',
  json: 'JSON',
  yaml: 'YAML',
  shell: 'Shell',
  nginx: 'nginx',
  properties: 'Config',
  toml: 'TOML',
  dockerfile: 'Dockerfile',
  diff: 'Diff',
  lua: 'Lua',
  perl: 'Perl',
  python: 'Python',
  javascript: 'JavaScript',
  xml: 'XML',
  html: 'HTML',
  sql: 'SQL',
  css: 'CSS'
}

export function languageLabel(id: LanguageId): string {
  return LABELS[id]
}

/**
 * 按**整个文件名**认人的一批。
 *
 * 这一批比扩展名重要得多：Linux 上真正常被编辑的配置文件一半没有扩展名
 * （sshd_config、fstab、crontab、.bashrc），只看扩展名的话它们全落到纯文本。
 */
const BY_NAME: Record<string, LanguageId> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  'nginx.conf': 'nginx',

  // shell：登录脚本那一族
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_logout': 'shell',
  '.bash_aliases': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  '.zshenv': 'shell',
  '.kshrc': 'shell',
  // crontab 给 shell 而不是 properties：它的右半边就是一条命令，
  // 用 shell 着色能把管道、引号、变量都点亮，properties 只会认出 # 注释
  crontab: 'shell',

  // key/value 那一族。properties 模式认的是"左边 = 右边"与 # / ; 注释，
  // 正好覆盖 sshd_config 这种空格分隔的写法（左边仍被当成键）
  sshd_config: 'properties',
  ssh_config: 'properties',
  'my.cnf': 'properties',
  'php.ini': 'properties',
  'redis.conf': 'properties',
  'supervisord.conf': 'properties',
  'httpd.conf': 'properties',
  'smb.conf': 'properties',
  'resolv.conf': 'properties',
  'sysctl.conf': 'properties',
  'limits.conf': 'properties',
  'logrotate.conf': 'properties',
  fstab: 'properties',
  hosts: 'properties',
  hostname: 'properties',
  gitconfig: 'properties',
  '.gitconfig': 'properties',
  '.npmrc': 'properties',
  '.editorconfig': 'properties',
  '.inputrc': 'properties',
  '.env': 'properties'
}

const BY_EXT: Record<string, LanguageId> = {
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yml: 'yaml',
  yaml: 'yaml',

  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',

  conf: 'properties',
  cnf: 'properties',
  cfg: 'properties',
  ini: 'properties',
  properties: 'properties',
  // systemd unit 全家：语法就是 [Section] key=value
  service: 'properties',
  socket: 'properties',
  timer: 'properties',
  target: 'properties',
  mount: 'properties',
  desktop: 'properties',
  repo: 'properties',
  // /etc/apt/sources.list.d/*.list
  list: 'properties',

  toml: 'toml',
  diff: 'diff',
  patch: 'diff',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  py: 'python',
  pyw: 'python',

  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // .ts/.tsx 用 legacy 的 js 模式着色：类型注解不会被认出来，但关键字/字符串/注释都对。
  // 这是为了字节预算做的取舍（真 TS 解析器要多背一个 lezer-javascript），
  // 而在一台服务器上编辑 .ts 本来就是少数情况
  ts: 'javascript',
  mts: 'javascript',
  cts: 'javascript',
  jsx: 'javascript',
  tsx: 'javascript',

  xml: 'xml',
  xsl: 'xml',
  xsd: 'xml',
  plist: 'xml',
  svg: 'xml',
  rss: 'xml',
  html: 'html',
  htm: 'html',

  sql: 'sql',
  css: 'css',
  scss: 'css',
  less: 'css'
}

/** shebang → 语言。用于没有扩展名的脚本，这在 /usr/local/bin 下是常态 */
const SHEBANGS: Array<[RegExp, LanguageId]> = [
  [/^#!.*\b(bash|sh|zsh|ksh|dash|ash)\b/, 'shell'],
  [/^#!.*\bpython[\d.]*\b/, 'python'],
  [/^#!.*\bperl\b/, 'perl'],
  [/^#!.*\bnode\b/, 'javascript'],
  [/^#!.*\blua\b/, 'lua']
]

/**
 * 判定语法着色。
 *
 * 顺序：整名 → 目录线索 → 扩展名 → shebang → 纯文本。
 *
 * shebang 排在扩展名**后面**是有意的：`.sh` 里写 `#!/usr/bin/env python` 的情况极少，
 * 而 shebang 真正要救的是"根本没有扩展名"那一类 —— 那类走不到扩展名这一步，
 * 自然落到它。反过来把 shebang 提前，`deploy.sh` 这种带 `#!/bin/sh -e` 的
 * 也只是同样结果，收益为零而分支更绕。
 *
 * @param firstLine 文件第一行（调用方从已读到的正文里切，不额外发请求）
 */
export function resolveLanguage(path: string, firstLine = ''): LanguageId {
  const base = (path.split('/').pop() ?? '').toLowerCase()

  const byName = BY_NAME[base]
  if (byName) return byName
  // Dockerfile.dev / Dockerfile.prod 这类后缀写法
  if (base.startsWith('dockerfile.')) return 'dockerfile'

  // 只在**最后一个点之后还有字符**时才算扩展名：`.bashrc` 的点在开头，不是扩展名
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 && dot < base.length - 1 ? base.slice(dot + 1) : ''

  /*
   * 目录线索：nginx 的站点配置极少叫 nginx.conf —— 它们是 sites-available/default、
   * conf.d/api.conf、sites-enabled/example.com 这种名字，只看名字会全落到 properties
   * 或纯文本，而 properties 对 nginx 的 `location / { … }` 块着色是错的（那里没有等号）。
   *
   * 三个条件是拼出来的，每一条背后都有一个被用例抓住的反例：
   *  - 无扩展名 / .conf / .types → nginx。这一支必须排在扩展名表**前面**，
   *    因为 `.conf` 在扩展名表里是 properties，而 conf.d/api.conf 是 nginx 语法。
   *  - 直接在 sites-available / sites-enabled 里、且扩展名表认不出来 → nginx。
   *    反例是 sites-enabled/example.com：按域名命名是 nginx 的惯例，
   *    而 `com` 不可能进白名单。加"扩展名表认不出来"这个前提，
   *    是为了让 sites-enabled/deploy.yml 仍然按 yaml 走。
   *  - 其余一律不认。反例是 /var/log/nginx/access.log 与 /etc/nginx/ssl/site.pem ——
   *    nginx 的日志和证书不是 nginx 配置。这里刻意**不用**"排除某些扩展名"的黑名单：
   *    要排的东西一列就没边（.log/.pid/.sock/.pem/.crt/.key/.htpasswd…），
   *    而第一版就是这么写的、就是被 access.log 抓红的。
   */
  const lowerPath = path.toLowerCase()
  const nginxish =
    /(^|\/)nginx(\/|$)/.test(lowerPath) || /\/(sites-available|sites-enabled)\//.test(lowerPath)
  if (nginxish) {
    const inSitesDir = /\/(sites-available|sites-enabled)\/[^/]+$/.test(lowerPath)
    if (ext === '' || ext === 'conf' || ext === 'types') return 'nginx'
    if (inSitesDir && !BY_EXT[ext]) return 'nginx'
  }

  if (ext) {
    const byExt = BY_EXT[ext]
    if (byExt) return byExt
  }

  for (const [re, id] of SHEBANGS) if (re.test(firstLine)) return id
  return 'plain'
}
