import { describe, expect, it } from 'vitest'
import { maskHost } from '@/features/connections/maskHost'
import { read, stripComments } from '../sourceGuard'

/**
 * 连接列表 host 打码。规则是"留首尾、遮中间"，要点：
 *  - 打了码（含遮罩符），但保留了能区分机器的片段；
 *  - 只影响显示 —— 连接/复制命令/搜索仍用完整 host（护栏在下面钉死）。
 */

describe('maskHost：IPv4', () => {
  it('留首尾两段，遮中间两段', () => {
    expect(maskHost('156.248.10.50')).toBe('156.•.•.50')
    expect(maskHost('82.47.34.254')).toBe('82.•.•.254')
    expect(maskHost('8.8.8.8')).toBe('8.•.•.8')
  })

  it('同末段但不同网段仍可区分（首段没被遮）', () => {
    // 截图里 ByteVirt-JP1=155.117.155.2 与 -TW=151.242.188.2 末段都是 2
    expect(maskHost('155.117.155.2')).toBe('155.•.•.2')
    expect(maskHost('151.242.188.2')).toBe('151.•.•.2')
    expect(maskHost('155.117.155.2')).not.toBe(maskHost('151.242.188.2'))
  })

  it('遮住了中间（不泄露完整地址）', () => {
    const out = maskHost('156.248.10.50')
    expect(out).toContain('•')
    expect(out).not.toContain('248')
    expect(out).not.toContain('10')
  })
})

describe('maskHost：IPv6', () => {
  it('留首尾两组', () => {
    expect(maskHost('2001:4860:4860::8888')).toBe('2001:…:8888')
    expect(maskHost('fd00::1')).toBe('fd00:…:1')
  })
  it('去掉字面量方括号', () => {
    expect(maskHost('[2001:db8::1]')).toBe('2001:…:1')
  })
})

describe('maskHost：域名', () => {
  it('三段及以上：留最左标签 + 顶级域，遮注册域', () => {
    expect(maskHost('jp1.eepzau.org')).toBe('jp1.•••.org')
    expect(maskHost('prod-db.internal.example.com')).toBe('prod-db.•••.com')
  })
  it('两段：遮注册域、留顶级域', () => {
    expect(maskHost('eepzau.org')).toBe('eep•••.org')
    expect(maskHost('example.com')).toBe('exam•••.com')
  })
  it('单段主机名：留前几个字符', () => {
    expect(maskHost('ciw0nigwbcsz8')).toBe('ciw0•••')
    expect(maskHost('8ivgb5if9in8fx')).toBe('8ivg•••')
    // 不同随机主机名首字符不同 → 仍可区分
    expect(maskHost('ciw0nigwbcsz8')).not.toBe(maskHost('8ivgb5if9in8fx'))
  })
  it('很短的名字也遮一点', () => {
    expect(maskHost('nas')).toBe('na•••')
    expect(maskHost('db')).toBe('d•')
  })
})

describe('maskHost：边界', () => {
  it('空/纯空白原样返回，不抛', () => {
    expect(maskHost('')).toBe('')
    expect(maskHost('   ')).toBe('   ')
  })
})

describe('接线护栏', () => {
  const panel = stripComments(read('src/renderer/src/features/connections/ConnectionTreePanel.tsx'))

  it('行内副标题用 maskHost，且受 maskInList 设置开关（不是无条件打码）', () => {
    expect(panel).toContain("import { maskHost } from './maskHost'")
    expect(panel).toContain('maskInList ? maskHost(p.host) : p.host')
    expect(panel).toContain('connection.maskHostInList')
  })

  it('连接/复制/搜索仍用完整 host —— 打码只影响显示', () => {
    // 复制 SSH 命令：用真 host（打码进了这里会连不上）
    expect(panel).toContain('@${p.host} -p')
    // 搜索过滤：用真 host（打码进了这里按 IP 搜不到）
    expect(panel).toContain('p.host.toLowerCase()')
    // 复制命令那行不能出现 maskHost
    const copyLine = panel.split('\n').find((l) => l.includes('clipboard.writeText')) ?? ''
    expect(copyLine).not.toContain('maskHost')
  })
})
