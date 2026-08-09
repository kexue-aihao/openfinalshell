/**
 * 连接列表里对 IP / 主机名做脱敏（打码）：只保留能区分机器的首尾片段，遮住中间的关键部分，
 * 方便截图分享而不泄露完整地址。**只用于连接树的显示标签** —— 连接、复制 SSH 命令、搜索
 * 一律仍用原始 host（见 ConnectionTreePanel：copyCmd / 搜索过滤都读 p.host）。
 *
 * 规则（都以"留首尾、遮中间"为原则）：
 *  - IPv4  a.b.c.d      → 留首尾两段：`a.•.•.d`（同网段内末段区分机器，首段区分不同网段）
 *  - IPv6  h1:…:hn      → 留首尾两组：`h1:…:hn`
 *  - 三段及以上域名      → 留最左标签(常是地域/角色) + 顶级域，遮中间注册域：`jp1.•••.org`
 *  - 两段域名 sld.tld    → 遮注册域、留顶级域：`eep•••.org`
 *  - 单段主机名          → 留前几个字符：`ciw0•••`
 */

const M = '•'
const M3 = '•••'

/** 遮一个词：留前若干字符（最多 4、至少能区分），其余用固定 3 点代替（不暴露长度） */
function maskWord(w: string): string {
  if (w.length <= 2) return w.length ? `${w[0]}${M}` : w
  const keep = Math.min(4, Math.ceil(w.length / 2))
  return `${w.slice(0, keep)}${M3}`
}

export function maskHost(raw: string): string {
  const h = (raw ?? '').trim()
  if (!h) return raw
  const bare = h.replace(/^\[|\]$/g, '') // 去掉 IPv6 字面量方括号

  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (m4) return `${m4[1]}.${M}.${M}.${m4[4]}`

  if (bare.includes(':')) {
    const groups = bare.split(':').filter(Boolean)
    if (groups.length >= 2) return `${groups[0]}:…:${groups[groups.length - 1]}`
    return maskWord(bare)
  }

  const labels = bare.split('.')
  if (labels.length >= 3) return `${labels[0]}.${M3}.${labels[labels.length - 1]}`
  if (labels.length === 2) return `${maskWord(labels[0])}.${labels[1]}`
  return maskWord(labels[0])
}
