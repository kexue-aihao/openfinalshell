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
