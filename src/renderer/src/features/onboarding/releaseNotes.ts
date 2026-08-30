/**
 * 更新说明登记表：增量更新后开机弹窗展示"更新了什么/修复了什么"。
 *
 * 每次发版在**最前面**加一条当前版本（有护栏 releaseNotes.test.ts 钉死"package.json 的版本
 * 必须在表里"，忘了加会红）。文案双语内联，按当前界面语言取。
 */

export interface ReleaseNoteItem {
  type: 'feat' | 'fix'
  zh: string
  en: string
}
export interface ReleaseNote {
  version: string
  items: ReleaseNoteItem[]
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '0.19.2',
    items: [
      {
        type: 'feat',
        zh: '发布链新增 Windows ARM64 安装版与免安装版；Linux 同时构建 x64 和 ARM64 的 Debian 13、RPM、AppImage 包，并提供 x64 Flatpak 包。不同 Linux 包按发行版惯例使用 amd64、x86_64、arm64、aarch64 等架构名，下载时请按设备架构选择对应文件',
        en: 'The release pipeline now includes Windows ARM64 installer and portable builds, plus Debian 13, RPM, and AppImage packages for Linux x64 and ARM64, with Flatpak available for Linux x64. Linux artifacts use distribution-standard architecture names such as amd64, x86_64, arm64, and aarch64; choose the file matching your device'
      }
    ]
  },
  {
    version: '0.19.1',
    items: [
      {
        type: 'feat',
        zh: '服务器监控的延迟卡现在同时显示「直连 IP」与「实际连接」两条实时 RTT 趋势：前者由本机直接 Ping 连接目标、不经过软件代理；后者沿用当前 SSH 通道测量，会包含代理或隧道链路。服务器禁用 ICMP 或本机 Ping 不可用时会明确显示“不可用”，不再伪装为 0ms',
        en: 'The Server Monitor latency card now shows two live RTT trends: Direct IP pings the connection target locally without the app proxy, while Active connection measures the current SSH channel and includes proxy or tunnel overhead. If ICMP is blocked or local ping is unavailable, it is clearly marked unavailable instead of being shown as 0ms'
      }
    ]
  },
  {
    version: '0.18.5',
    items: [
      {
        type: 'fix',
        zh: '修复实时端口流量页在部分服务器上无法识别端口记录的问题；若服务器未提供完整的收发字节计数，仍会显示端口和连接数，并明确提示速率不可用',
        en: 'Fixed live port traffic records not being recognized on some servers. When a server does not provide complete sent and received byte counters, ports and connection counts remain visible and rates are clearly marked unavailable'
      }
    ]
  },
  {
    version: '0.18.4',
    items: [
      {
        type: 'fix',
        zh: '修复实时端口流量页因服务器将端口显示为 ssh/http 等服务名而识别不到端口的问题，现在强制使用数字端口显示',
        en: 'Fixed the live port traffic page showing no ports when servers rendered port numbers as service names such as ssh or http; numeric port output is now forced'
      }
    ]
  },
  {
    version: '0.18.3',
    items: [
      {
        type: 'feat',
        zh: '服务器监控的网络卡片现在可直接打开「端口流量」标签页，按秒显示远端各活动 TCP 本机端口的连接数、下行和上行速率。数据在服务器端先聚合后经当前 SSH 会话采集，关闭标签即停止；需要服务器提供 ss 命令，暂不统计 UDP',
        en: 'The Network card in Server Monitoring can now open a Port Traffic tab, showing each active remote TCP local port\'s connection count and receive/send rate every second. Data is aggregated on the server and collected through the current SSH session, stopping when the tab closes; it requires the server\'s ss command and does not yet include UDP'
      }
    ]
  },
  {
    version: '0.18.2',
    items: [
      {
        type: 'feat',
        zh: '私钥现在可选择保存一份由系统密钥库保护的本机加密副本：外部文件临时不可用时仍可连接，副本不会进入导出文件或局域网同步。Windows 上私钥位于可移动磁盘时，盘符变更后会按原相对路径在其他盘符查找，并以 SHA-256 指纹确认相同文件后自动更新路径',
        en: 'Private keys can now optionally keep a locally encrypted copy protected by the system key store, so connections can still work when the external file is temporarily unavailable. Copies never enter exports or LAN Sync. On Windows, when a key is on removable storage and its drive letter changes, the app searches the same relative path on other drives and updates the path only after confirming the SHA-256 fingerprint'
      }
    ]
  },
  {
    version: '0.18.1',
    items: [
      {
        type: 'feat',
        zh: '新增 Debian 13 amd64 正式安装包：可用 APT 安装和覆盖升级，SSH、终端、SFTP、监控与独立编辑器均通过安装后冒烟验证。Debian 版会提示新版本并打开 Releases，但不会自行提权安装；凭据使用 Secret Service/KWallet，缺少安全密钥库时不会把密码保存成明文',
        en: 'Added an official Debian 13 amd64 package: install or upgrade it with APT. SSH, terminal, SFTP, monitoring and the separate editor all pass an installed-package smoke test. The Debian build notifies you about releases but never elevates privileges to install them; credentials use Secret Service/KWallet and are not persisted in plaintext when no secure keyring is available'
      }
    ]
  },
  {
    version: '0.18.0',
    items: [
      {
        type: 'feat',
        zh: '新增「局域网同步」（设置 → 局域网同步）：把连接、快捷命令等数据直接发到同一局域网内的另一台电脑，免去导出文件再传。一台点「开始接收」显示 6 位配对码，另一台扫描或手输地址、输码即发，对方确认后按跳过/覆盖/复制合并。全程加密（配对码经椭圆曲线密钥交换派生会话密钥，线上除设备名外无明文），是发一份副本、不是双向同步。组播搜不到设备时手输 IP:端口 即可',
        en: 'New "LAN Sync" (Settings → LAN Sync): send connections, snippets and more straight to another computer on the same LAN — no export file to shuttle around. One side taps "Start receiving" to show a 6-digit pairing code; the other scans or types the address, enters the code, and sends; the receiver confirms and merges with skip/overwrite/duplicate. Fully encrypted (the pairing code derives a session key via elliptic-curve key exchange; nothing but the device name is in the clear), and it sends a one-time copy — not two-way sync. If discovery finds nothing, just type IP:port'
      }
    ]
  },
  {
    version: '0.17.1',
    items: [
      {
        type: 'fix',
        zh: '快捷命令（以及命令编辑器）执行的 cd 现在也会让 SFTP 面板跟着切目录了 —— 之前跟随只认手敲回车的命令，点快捷命令执行时命令照跑、历史照记，唯独目录跟随一声不吭地不动',
        en: 'A cd run from a saved snippet (or the command editor) now makes the SFTP panel follow along — following used to work only for commands typed by hand, so snippet-launched commands ran fine and were recorded in history, but the directory silently never followed'
      }
    ]
  },
  {
    version: '0.17.0',
    items: [
      {
        type: 'feat',
        zh: '内置编辑器改为独立窗口：所有 SSH 会话的「内置编辑器查看」都汇到同一个窗口里做多标签，标签带来源主机名 —— 两台机器上的同名 nginx.conf 一眼分得开；窗口尺寸有记忆',
        en: 'The built-in editor is now a separate window: every session\'s "View in built-in editor" goes into one shared multi-tab window, with the source host on each tab — same-named nginx.conf from two machines stay distinguishable; window size is remembered'
      },
      {
        type: 'feat',
        zh: '编辑中的内容更难丢了：会话断开只是挂一条「无法保存」的横幅，内容仍可编辑复制、重连后自动恢复保存；关编辑器窗口（或主窗口）时有未保存的文件会先确认。注意：会话面板里嵌入的编辑器格子已移除，编辑一律在独立窗口',
        en: 'Your edits are harder to lose: a disconnected session only banners the tab as "cannot save" — content stays editable and copyable, and saving resumes after reconnect; closing the editor window (or the main window) asks first if files are unsaved. Note: the editor pane embedded in the session view is gone — editing now always happens in the separate window'
      }
    ]
  },
  {
    version: '0.16.1',
    items: [
      {
        type: 'feat',
        zh: '目录读取提速回归：0.15.3 出于谨慎撤回的分页读取，已查明与当时的问题无关（真凶是 0.15.4 修掉的命令采集截断），现原样取回 —— 一次切目录少两个网络往返，/etc、/usr/bin 这类软链接多的目录最明显',
        en: 'The directory-listing speedup is back: the paged reader cautiously reverted in 0.15.3 was proven unrelated to that bug (the real cause was the command truncation fixed in 0.15.4) — switching directories is two round-trips faster again, most noticeable in symlink-heavy directories like /etc and /usr/bin'
      },
      {
        type: 'feat',
        zh: '给 cd 跟随这一整片补上了组件级回归测试（8 条，覆盖这轮修过的全部四个问题），并逐条验证过它们在旧版缺陷代码上会失败 —— 同类问题今后在发版前就会被拦住',
        en: 'The cd-following area now has component-level regression tests (8 cases covering all four recently fixed issues), each verified to fail on the old buggy code — regressions of this kind will now be caught before release'
      }
    ]
  },
  {
    version: '0.16.0',
    items: [
      {
        type: 'feat',
        zh: '里程碑版本：终端 cd 与 SFTP 面板的目录跟随已确认稳定（0.15.1～0.15.4 连续修掉了采集截断、提示符列冻结、快速连续切目录跳错、失败无声这几个问题）。代码与 0.15.4 相同',
        en: 'Milestone release: terminal cd → SFTP directory following is confirmed stable (0.15.1–0.15.4 fixed command truncation, a frozen prompt column, landing in the wrong directory when switching quickly, and silent failures). Code is identical to 0.15.4'
      }
    ]
  },
  {
    version: '0.15.4',
    items: [
      {
        type: 'fix',
        zh: '修好了 cd 跟随的真正原因：命令在采集时会被截断。终端里的字是服务器回显回来的，而我们在回车那一刻就去读屏，你最后几个字符（尤其是按 Tab 让服务器补全的部分）还没回来 —— 于是 cd /etc/v2node 被读成 cd /etc/v2n，跟随去读一个不存在的目录。现在改为等命令行回显完整后再采集',
        en: 'Fixed the real cause of cd-following failures: the command was captured truncated. Terminal text arrives as server echo, but capture happened the instant Enter was pressed — the last characters (especially a Tab completion) had not arrived yet, so "cd /etc/v2node" was read as "cd /etc/v2n". Capture now waits until the echoed command line is complete'
      },
      {
        type: 'fix',
        zh: '同一原因也让命令历史记进被截断的命令（Ctrl+Shift+H 里那些看着不对的条目）。新记录已正常，旧的可在 设置 → 安全与数据 里清空历史',
        en: 'The same cause recorded truncated commands into history (the odd-looking entries under Ctrl+Shift+H). New entries are correct; old ones can be cleared via Settings → Security & Data'
      }
    ]
  },
  {
    version: '0.15.3',
    items: [
      {
        type: 'fix',
        zh: '目录跟随失败时会明确告诉你原因（例如没有权限、目录不存在），不再只是路径闪一下就弹回去 —— 之前这个失败是完全无声的，既看不到也查不到',
        en: 'When following a directory fails you now get the actual reason (no permission, directory missing, …) instead of the path flashing and snapping back — previously the failure was completely silent'
      },
      {
        type: 'fix',
        zh: '撤回 0.15.2 的目录读取提速：它可能导致某些目录读不出来。切目录会慢回原来的样子，等原因查清后再重做提速',
        en: 'Reverted the 0.15.2 directory-listing speedup: it may have made some directories unreadable. Switching directories is back to the previous speed until the cause is confirmed'
      }
    ]
  },
  {
    version: '0.15.2',
    items: [
      {
        type: 'feat',
        zh: '终端 cd 之后 SFTP 面板「按下即翻页」：路径与面包屑立刻切到目标目录，列表位置先显示骨架，不再等一个网络往返才有反应',
        en: 'The SFTP pane now switches the moment you press Enter: the path and breadcrumb jump to the target directory immediately and the list shows a skeleton, instead of sitting still for a whole round-trip'
      },
      {
        type: 'feat',
        zh: '目录读取快了：分页读取时顺带解析软链接，一次切目录少两个网络往返（软链接多的目录如 /etc、/usr/bin 最明显）',
        en: 'Directory listing is faster: symlinks are resolved while paging through entries, cutting two round-trips per directory switch (most noticeable in symlink-heavy directories such as /etc and /usr/bin)'
      },
      {
        type: 'fix',
        zh: '修复快速连续切目录时可能跳错目录：先后发出的两次读取回来的顺序不定，旧的那次会把面板压回上一个目录',
        en: 'Fixed landing in the wrong directory when switching quickly: two listings could return out of order and the older one would snap the pane back'
      },
      {
        type: 'fix',
        zh: '修复一次读取失败后表格被错误提示永久占住，之后即使 cd 跟随成功也要手动刷新才恢复',
        en: 'Fixed the file table staying stuck on an error message after one failed listing, needing a manual refresh even once following succeeded again'
      }
    ]
  },
  {
    version: '0.15.1',
    items: [
      {
        type: 'fix',
        zh: '修复终端 cd 之后 SFTP 面板不跟随跳转：终端输出把回滚缓冲用满（或清屏两次）之后，提示符位置会被记错，cd 到更深的目录就跟不动了',
        en: 'Fixed the SFTP pane not following a terminal cd: once terminal output filled the scrollback (or the screen was cleared twice), the prompt position was mis-measured and cd into a deeper directory stopped working'
      },
      {
        type: 'fix',
        zh: '同一原因也会让命令历史记进提示符残片（如 "p# ls"）—— 新记录已恢复正常，已混入的残片可在 设置 → 安全与数据 里清空历史',
        en: 'The same cause also recorded prompt fragments into command history (e.g. "p# ls"). New entries are correct now; existing fragments can be removed via Settings → Security & Data → clear history'
      }
    ]
  },
  {
    version: '0.15.0',
    items: [
      {
        type: 'feat',
        zh: '配置数据本地加密存储：除密码外，主机/端口/用户名/分组/代理/转发/已信任主机/命令历史也在数据库里加密（绑定当前系统账户），直接打开 .db 看不到明文',
        en: 'Config data is now encrypted at rest: besides passwords, hosts/ports/usernames/groups/proxies/forwards/known-hosts/command history are encrypted in the database (bound to the current OS account) — opening the .db shows no plaintext'
      },
      {
        type: 'feat',
        zh: '新增「整文件加密导出」：给一个口令，连主机、用户名等配置一起加密，导出文件里没有任何明文（换机迁移请走加密导出→新机导入，不能直接拷数据库）',
        en: 'New "encrypt the entire file" export: with a passphrase, hosts/usernames and all config are encrypted so the file has no plaintext (migrate via encrypted export → import; copying the .db no longer works)'
      },
      {
        type: 'feat',
        zh: '关于页新增「历史更新日志」按钮，可查看所有版本的更新说明',
        en: 'Added a "Changelog" button on the About page to view release notes for every version'
      }
    ]
  },
  {
    version: '0.14.0',
    items: [
      {
        type: 'feat',
        zh: '全球多语种支持：新增 繁体中文/日语/韩语/俄语/西班牙语/法语/德语/葡萄牙语，共 10 种语言，设置里可切换（非中英为机器翻译，欢迎在 GitHub 反馈校对）',
        en: 'Global localization: added Traditional Chinese, Japanese, Korean, Russian, Spanish, French, German, and Portuguese — 10 languages total, switch in Settings (non-CN/EN are machine-translated; corrections welcome on GitHub)'
      },
      {
        type: 'feat',
        zh: '主进程的报错提示也随语言翻译（认证、连接、代理、传输等）',
        en: 'Main-process error messages are localized too (auth, connection, proxy, transfer, and more)'
      }
    ]
  },
  {
    version: '0.13.0',
    items: [
      {
        type: 'feat',
        zh: '新增开机引导：全新安装介绍功能与快捷键，更新后展示本次更新说明',
        en: 'Startup guide: fresh installs get a feature & shortcut intro; updates show what changed'
      },
      {
        type: 'feat',
        zh: '关于页新增赞赏码（USDT / BNB / ETH / POL / 微信 / 支付宝），支持这个项目 ❤',
        en: 'Donation codes on the About page (USDT / BNB / ETH / POL / WeChat / Alipay) — support the project ❤'
      }
    ]
  },
  {
    version: '0.12.0',
    items: [
      {
        type: 'feat',
        zh: '连接列表的 IP / 主机名支持打码脱敏（只显示首尾片段，便于截图分享），可在设置→外观关闭',
        en: 'Connection list can mask IP / hostname (shows only head+tail, safe for screenshots); toggle in Settings → Appearance'
      },
      {
        type: 'feat',
        zh: '连接列表副标题字体更清晰（对比度、字号提升，长地址不再被裁）',
        en: 'Clearer connection-list subtitle (higher contrast, larger size, long addresses no longer clipped)'
      }
    ]
  },
  {
    version: '0.11.0',
    items: [
      {
        type: 'feat',
        zh: '连接位置标记改用 Twemoji 国旗，小尺寸下更清晰准确',
        en: 'Location markers now use Twemoji flags — crisper and more accurate at small sizes'
      }
    ]
  },
  {
    version: '0.10.0',
    items: [
      {
        type: 'feat',
        zh: '连接位置标记：手选国旗 + 局域网自动识别',
        en: 'Location markers: pick a country flag, LAN hosts auto-detected'
      },
      {
        type: 'fix',
        zh: '重连时"握手前断开"给出更友好的排错提示',
        en: 'Friendlier diagnostics for "connection lost before handshake" on reconnect'
      }
    ]
  },
  {
    version: '0.9.0',
    items: [
      {
        type: 'feat',
        zh: '服务器监控面板重绘为 btop 风格的渐变曲线',
        en: 'Server monitor redrawn as btop-style gradient graphs'
      },
      {
        type: 'feat',
        zh: '命令编辑器：发送后自动关窗，每次打开都是空白',
        en: 'Command editor: auto-closes after sending, opens blank every time'
      }
    ]
  },
  {
    version: '0.8.0',
    items: [
      {
        type: 'feat',
        zh: 'RDP 远程桌面（走系统 mstsc）',
        en: 'RDP remote desktop (via the system mstsc)'
      },
      {
        type: 'feat',
        zh: '全局默认代理 + 单连接代理微调；机器备注；启动最大化',
        en: 'Global default proxy + per-connection override; machine notes; start maximized'
      },
      {
        type: 'fix',
        zh: 'SFTP 双击打开的延迟与卡顿',
        en: 'SFTP double-click latency and jank'
      }
    ]
  },
  {
    version: '0.7.0',
    items: [
      {
        type: 'feat',
        zh: '监控延迟(RTT)图、已信任主机指纹管理、终端字号即时调节等六项增强',
        en: 'Monitor latency (RTT) graph, trusted host-key management, live terminal font sizing, and more'
      }
    ]
  }
]

/** 语义化版本比较：a<b 返回 -1，a>b 返回 1，相等 0（只看数字段，忽略预发布后缀） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * 取 (from, to] 之间的更新说明，按新→旧排列（跨版本更新能一次看全跳过的那些）。
 * from 缺省（正常 update 一定有）时只给 to 那条。
 */
export function notesSince(from: string | undefined, to: string): ReleaseNote[] {
  return RELEASE_NOTES.filter(
    (n) =>
      compareVersions(n.version, to) <= 0 &&
      (from ? compareVersions(n.version, from) > 0 : compareVersions(n.version, to) === 0)
  ).sort((a, b) => compareVersions(b.version, a.version))
}
