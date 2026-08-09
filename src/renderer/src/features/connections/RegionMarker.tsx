/**
 * 位置标记：一组简化国旗（内联 SVG）+ 局域网标志 + 地球（公网/默认）。
 *
 * 为什么不用 emoji 国旗：Windows 不渲染 regional-indicator emoji（只显示 "JP" 这种两字母），
 * 所以必须自绘 SVG。为什么简化：这是 14px 的小标记，星徽/纹章级别的精度既画不出也看不清，
 * 用主色块 + 一个特征形状足以一眼认出（日之丸、三色带、五星…）。离线、零资源。
 */

export interface Region {
  code: string
  /** 中文名，选择器里显示 */
  label: string
}

/** 选择器里给的常见服务器所在地（不追求全，够用即可；用户按物理位置手选） */
export const REGIONS: Region[] = [
  { code: 'lan', label: '局域网' },
  { code: 'CN', label: '中国大陆' },
  { code: 'HK', label: '香港' },
  { code: 'TW', label: '台湾' },
  { code: 'JP', label: '日本' },
  { code: 'KR', label: '韩国' },
  { code: 'SG', label: '新加坡' },
  { code: 'US', label: '美国' },
  { code: 'CA', label: '加拿大' },
  { code: 'GB', label: '英国' },
  { code: 'DE', label: '德国' },
  { code: 'FR', label: '法国' },
  { code: 'NL', label: '荷兰' },
  { code: 'RU', label: '俄罗斯' },
  { code: 'IN', label: '印度' },
  { code: 'AU', label: '澳大利亚' },
  { code: 'BR', label: '巴西' },
  { code: 'globe', label: '其它/公网' }
]

/**
 * host 是否是局域网/内网地址。纯离线判断，不做任何查询：
 * 私有 IPv4 段（10/8、172.16–31、192.168/16）、回环、链路本地，以及 localhost、
 * *.local、单段无点主机名（内网机器名常见）。用来在用户没手选标记时自动显示局域网图标。
 */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '') // 去掉 IPv6 字面量的方括号
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.local')) return true
  // IPv6 回环 / 唯一本地地址(fc/fd) / 链路本地(fe80)
  if (h === '::1' || /^f[cd][0-9a-f]*:/.test(h) || h.startsWith('fe80:')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 10 || a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return false
  }
  // 不是 IP、不含点的单段主机名（如 "nas"、"gitlab"）→ 视为内网机器名。
  // 必须排除含 ':' 的：公网 IPv6（2001:...）同样没有点，不能被这条误判成内网
  return !h.includes('.') && !h.includes(':')
}

/**
 * 连接树实际显示哪个标记：显式手选优先；否则私网地址自动局域网；再否则交给 color 色点。
 * 返回 null 表示"没有标记，用回退色点"。
 */
export function effectiveMarker(flag: string | undefined, host: string): string | null {
  if (flag) return flag
  if (isPrivateHost(host)) return 'lan'
  return null
}

/** 简化旗面：24×16 viewBox，圆角靠 CSS 裁切（画到边缘的形状被 border-radius 修掉） */
const FLAGS: Record<string, React.JSX.Element> = {
  JP: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <circle cx="12" cy="8" r="4" fill="#bc002d" />
    </>
  ),
  CN: (
    <>
      <rect width="24" height="16" fill="#de2910" />
      <path d="M5 3l1 2.6 2.6.1-2 1.7.7 2.5L5 8.4 2.9 9.9l.7-2.5-2-1.7 2.6-.1z" fill="#ffde00" />
    </>
  ),
  HK: (
    <>
      <rect width="24" height="16" fill="#de2910" />
      <circle cx="12" cy="8" r="3.2" fill="#fff" />
      <circle cx="12" cy="8" r="1.4" fill="#de2910" />
    </>
  ),
  TW: (
    <>
      <rect width="24" height="16" fill="#fe0000" />
      <rect width="12" height="8" fill="#000095" />
      <circle cx="6" cy="4" r="2.2" fill="#fff" />
    </>
  ),
  KR: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <path d="M12 4a4 4 0 010 8 2 2 0 000-4 2 2 0 010-4z" fill="#cd2e3a" />
      <path d="M12 4a4 4 0 000 8 2 2 0 010-4 2 2 0 000-4z" fill="#0047a0" />
    </>
  ),
  SG: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="24" height="8" fill="#ed2939" />
      <circle cx="6" cy="4" r="2.6" fill="#fff" />
      <circle cx="7" cy="4" r="2.6" fill="#ed2939" />
    </>
  ),
  US: (
    <>
      <rect width="24" height="16" fill="#fff" />
      {[0, 2, 4, 6].map((i) => (
        <rect key={i} y={i * 2.3} width="24" height="1.15" fill="#b22234" />
      ))}
      {[1, 3, 5].map((i) => (
        <rect key={i} y={i * 2.3} width="24" height="1.15" fill="#b22234" />
      ))}
      <rect width="10" height="8" fill="#3c3b6e" />
    </>
  ),
  CA: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="6" height="16" fill="#d52b1e" />
      <rect x="18" width="6" height="16" fill="#d52b1e" />
      <path d="M12 4l1 2 2-.5-1 2 1 .5-2 .3.2 2-1.4-1.2-1.4 1.2.2-2-2-.3 1-.5-1-2 2 .5z" fill="#d52b1e" />
    </>
  ),
  GB: (
    <>
      <rect width="24" height="16" fill="#012169" />
      <path d="M0 0l24 16M24 0L0 16" stroke="#fff" strokeWidth="3" />
      <path d="M12 0v16M0 8h24" stroke="#fff" strokeWidth="5" />
      <path d="M12 0v16M0 8h24" stroke="#c8102e" strokeWidth="2.5" />
    </>
  ),
  DE: (
    <>
      <rect width="24" height="16" fill="#000" />
      <rect y="5.33" width="24" height="5.33" fill="#dd0000" />
      <rect y="10.66" width="24" height="5.34" fill="#ffce00" />
    </>
  ),
  FR: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="8" height="16" fill="#002395" />
      <rect x="16" width="8" height="16" fill="#ed2939" />
    </>
  ),
  NL: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="24" height="5.33" fill="#ae1c28" />
      <rect y="10.66" width="24" height="5.34" fill="#21468b" />
    </>
  ),
  RU: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect y="5.33" width="24" height="5.33" fill="#0039a6" />
      <rect y="10.66" width="24" height="5.34" fill="#d52b1e" />
    </>
  ),
  IN: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="24" height="5.33" fill="#ff9933" />
      <rect y="10.66" width="24" height="5.34" fill="#138808" />
      <circle cx="12" cy="8" r="1.6" fill="none" stroke="#000080" strokeWidth="0.7" />
    </>
  ),
  AU: (
    <>
      <rect width="24" height="16" fill="#00008b" />
      <rect width="10" height="8" fill="#012169" />
      <path d="M0 0l10 8M10 0L0 8" stroke="#fff" strokeWidth="1.6" />
      <path d="M5 0v8M0 4h10" stroke="#fff" strokeWidth="2.4" />
      <path d="M5 0v8M0 4h10" stroke="#c8102e" strokeWidth="1.1" />
      <circle cx="18" cy="10" r="1" fill="#fff" />
      <circle cx="15" cy="5" r="0.8" fill="#fff" />
    </>
  ),
  BR: (
    <>
      <rect width="24" height="16" fill="#009c3b" />
      <path d="M12 2l9 6-9 6-9-6z" fill="#ffdf00" />
      <circle cx="12" cy="8" r="3" fill="#002776" />
    </>
  )
}

const LAN = (
  <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="9" width="4" height="3" />
    <rect x="16" y="9" width="4" height="3" />
    <rect x="10" y="3" width="4" height="3" />
    <path d="M12 6v2M6 9V8h12v1M18 9V8" />
  </g>
)

const GLOBE = (
  <g fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="12" cy="8" r="6" />
    <path d="M6 8h12M12 2v12M7.5 4.5c2 2 7 2 9 0M7.5 11.5c2-2 7-2 9 0" />
  </g>
)

/**
 * 渲染一个位置标记。`code` 是国家/地区代码、`'lan'`、`'globe'`；未知一律回退地球。
 * size 默认 14（连接树节点里的行内标记）。
 */
export function RegionMarker({ code, size = 14 }: { code: string; size?: number }): React.JSX.Element {
  const isLan = code === 'lan'
  const isGlobe = code === 'globe' || (!isLan && !FLAGS[code])
  const w = isLan || isGlobe ? size : Math.round((size * 3) / 2)
  return (
    <svg
      width={w}
      height={size}
      viewBox={isLan || isGlobe ? '0 0 24 16' : '0 0 24 16'}
      style={{
        borderRadius: 2,
        overflow: 'hidden',
        flex: 'none',
        color: isLan ? 'var(--ofs-text-2)' : isGlobe ? 'var(--ofs-text-3)' : undefined,
        boxShadow: isLan || isGlobe ? undefined : '0 0 0 0.5px rgba(0,0,0,0.25)'
      }}
      aria-hidden
    >
      {isLan ? LAN : isGlobe ? GLOBE : FLAGS[code]}
    </svg>
  )
}
