import { describe, expect, it } from 'vitest'
import { languageLabel, resolveLanguage, type LanguageId } from '@/features/editor/editorPolicy'

/**
 * 语法着色的判定表。
 *
 * 这份表承载的是**经验**而不是逻辑：Linux 上真正常被编辑的配置文件有一半没有扩展名
 * （sshd_config、fstab、crontab、.bashrc），只按扩展名判会把它们全落到纯文本 ——
 * 而"没有颜色"正是用户会说"这个编辑器不行"的那个观感。所以整名表、目录线索、
 * 扩展名、shebang 四条路各有存在理由，每条都要有用例钉住。
 */

const cases: Array<[string, LanguageId, string?]> = [
  // ---- 整名认人：没有扩展名，但一眼能认出来 ----
  ['/etc/ssh/sshd_config', 'properties'],
  ['/etc/fstab', 'properties'],
  ['/etc/hosts', 'properties'],
  ['/etc/my.cnf', 'properties'],
  ['/etc/php.ini', 'properties'],
  ['/root/.env', 'properties'],
  ['/root/.gitconfig', 'properties'],
  ['/root/.bashrc', 'shell'],
  ['/root/.zshrc', 'shell'],
  ['/root/.profile', 'shell'],
  // crontab 给 shell：它的右半边就是一条命令，properties 只会认出 # 注释
  ['/var/spool/cron/crontab', 'shell'],
  ['/srv/app/Dockerfile', 'dockerfile'],
  ['/srv/app/Dockerfile.prod', 'dockerfile'],
  ['/srv/app/Containerfile', 'dockerfile'],
  ['/etc/nginx/nginx.conf', 'nginx'],

  // ---- 目录线索：nginx 的站点配置几乎从不叫 nginx.conf ----
  ['/etc/nginx/conf.d/api.conf', 'nginx'],
  ['/etc/nginx/sites-available/default', 'nginx'],
  ['/etc/nginx/sites-enabled/example.com', 'nginx'],
  ['/etc/nginx/mime.types', 'nginx'],
  // 但 nginx 目录下别的扩展名不归它 —— 目录线索是白名单（无扩展名 / .conf / .types）。
  // 黑名单写法在这里被用例抓过：access.log 曾被判成 nginx
  ['/etc/nginx/meta.json', 'json'],
  ['/etc/nginx/deploy.yml', 'yaml'],
  ['/etc/nginx/ssl/site.pem', 'plain'],
  ['/var/log/nginx/error.log', 'plain'],
  // sites-* 里按域名命名是惯例，所以那里"扩展名表认不出来"就算 nginx；
  // 但认得出来的（.yml）仍按扩展名走
  ['/etc/nginx/sites-enabled/deploy.yml', 'yaml'],
  ['/etc/nginx/sites-available/api.example.com', 'nginx'],

  // ---- 扩展名 ----
  ['/srv/app/package.json', 'json'],
  ['/srv/app/docker-compose.yml', 'yaml'],
  ['/srv/k8s/deploy.yaml', 'yaml'],
  ['/etc/systemd/system/app.service', 'properties'],
  ['/etc/systemd/system/app.timer', 'properties'],
  ['/etc/apt/sources.list.d/docker.list', 'properties'],
  ['/srv/cfg/config.toml', 'toml'],
  ['/tmp/fix.patch', 'diff'],
  ['/tmp/a.diff', 'diff'],
  ['/opt/openresty/x.lua', 'lua'],
  ['/usr/bin/tool.pl', 'perl'],
  ['/srv/app/manage.py', 'python'],
  ['/srv/app/server.mjs', 'javascript'],
  ['/srv/app/index.ts', 'javascript'],
  ['/srv/app/pom.xml', 'xml'],
  ['/var/www/index.html', 'html'],
  ['/var/www/site.css', 'css'],
  ['/var/www/site.scss', 'css'],
  ['/srv/db/schema.sql', 'sql'],
  ['/srv/app/deploy.sh', 'shell'],

  // ---- shebang：没有扩展名的脚本，这在 /usr/local/bin 下是常态 ----
  ['/usr/local/bin/deploy', 'shell', '#!/bin/bash\nset -e\n'],
  ['/usr/local/bin/deploy', 'shell', '#!/usr/bin/env sh\n'],
  ['/usr/local/bin/report', 'python', '#!/usr/bin/env python3\nimport os\n'],
  ['/usr/local/bin/report', 'python', '#!/usr/bin/python2.7\n'],
  ['/usr/local/bin/x', 'perl', '#!/usr/bin/perl -w\n'],
  ['/usr/local/bin/x', 'javascript', '#!/usr/bin/env node\n'],
  ['/usr/local/bin/x', 'lua', '#!/usr/bin/lua\n'],

  // ---- 落到纯文本：认不出来就不猜 ----
  ['/var/log/syslog', 'plain'],
  ['/var/log/nginx/access.log', 'plain'],
  ['/srv/data/dump.csv', 'plain'],
  ['/srv/README.md', 'plain'],
  ['/usr/local/bin/mystery', 'plain'],
  ['/', 'plain'],
  ['', 'plain']
]

describe('resolveLanguage', () => {
  it.each(cases)('%s → %s', (path, expected, firstLine) => {
    expect(resolveLanguage(path, firstLine)).toBe(expected)
  })

  /**
   * 扩展名压过 shebang，这条是刻意的（见 editorPolicy 的说明）：
   * shebang 要救的是"根本没有扩展名"那一类，而 `.sh` 里写 python 的 shebang 极少见。
   * 写成用例是为了下次有人想调顺序时，先看见这是个决定而不是疏忽。
   */
  it('有扩展名时不看 shebang', () => {
    expect(resolveLanguage('/x/deploy.sh', '#!/usr/bin/env python3')).toBe('shell')
  })

  /** 开头那个点不是扩展名分隔符 —— 否则 .bashrc 会被当成扩展名 "bashrc" */
  it('点开头的文件名不当扩展名解析', () => {
    expect(resolveLanguage('/root/.bashrc')).toBe('shell')
    expect(resolveLanguage('/root/.unknownrc')).toBe('plain')
  })

  /** 大小写不敏感：Windows 侧下载回去再传上来的文件名大小写可能变 */
  it('大小写不敏感', () => {
    expect(resolveLanguage('/srv/APP/Package.JSON')).toBe('json')
    expect(resolveLanguage('/srv/DOCKERFILE')).toBe('dockerfile')
  })

  /** 只有斜杠分隔，不认反斜杠 —— 远端是 POSIX 路径，`a\b.json` 是一个合法文件名 */
  it('反斜杠是文件名的一部分，不是分隔符', () => {
    expect(resolveLanguage('/srv/weird\\name.json')).toBe('json')
  })
})

describe('languageLabel', () => {
  it('每个 id 都有名字（状态栏不会出现 undefined）', () => {
    const ids = new Set(cases.map(([, id]) => id))
    for (const id of ids) {
      expect(languageLabel(id), `${id} 没有显示名`).toBeTruthy()
    }
  })
})
