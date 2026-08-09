import { describe, expect, it } from 'vitest'
import { effectiveMarker, isPrivateHost, REGIONS } from '@/features/connections/RegionMarker'

/**
 * 位置标记的判定逻辑。国旗 SVG 长什么样没法测，但"哪些地址算局域网"和"显示哪个标记"
 * 有明确边界，错了会把公网机器标成局域网（或反过来），是能测也该测的。
 */

describe('isPrivateHost：私网/内网判定', () => {
  it('私有 IPv4 段算内网', () => {
    for (const h of ['10.0.0.5', '10.255.1.1', '192.168.1.1', '172.16.0.1', '172.31.255.1', '127.0.0.1', '169.254.1.2']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
  })

  it('172.16–31 之外的 172.x 是公网，不能误判', () => {
    expect(isPrivateHost('172.15.0.1')).toBe(false)
    expect(isPrivateHost('172.32.0.1')).toBe(false)
  })

  it('公网 IPv4 不算内网', () => {
    for (const h of ['8.8.8.8', '1.1.1.1', '155.117.155.225', '203.0.113.5']) {
      expect(isPrivateHost(h), h).toBe(false)
    }
  })

  it('localhost / *.local / 无点主机名算内网', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('nas.local')).toBe(true)
    expect(isPrivateHost('gitlab')).toBe(true) // 单段内网机器名
  })

  it('带点的域名算公网', () => {
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('jp1.eepzau.org')).toBe(false)
  })

  it('IPv6 回环/唯一本地/链路本地算内网，公网 v6 不算', () => {
    expect(isPrivateHost('::1')).toBe(true)
    expect(isPrivateHost('[::1]')).toBe(true) // 带方括号的字面量
    expect(isPrivateHost('fd00::1')).toBe(true)
    expect(isPrivateHost('fe80::1')).toBe(true)
    expect(isPrivateHost('2001:4860:4860::8888')).toBe(false)
  })
})

describe('effectiveMarker：显示哪个标记', () => {
  it('显式手选优先，无视地址', () => {
    expect(effectiveMarker('JP', '192.168.1.1')).toBe('JP')
    expect(effectiveMarker('US', '10.0.0.1')).toBe('US')
  })

  it('未手选 + 私网 → 自动局域网', () => {
    expect(effectiveMarker(undefined, '192.168.1.1')).toBe('lan')
  })

  it('未手选 + 公网 → null（交给颜色点回退）', () => {
    expect(effectiveMarker(undefined, '8.8.8.8')).toBeNull()
    expect(effectiveMarker('', '8.8.8.8')).toBeNull()
  })
})

describe('REGIONS 列表', () => {
  it('含局域网、地球与常见地区，且 code 唯一', () => {
    const codes = REGIONS.map((r) => r.code)
    expect(codes).toContain('lan')
    expect(codes).toContain('globe')
    expect(codes).toContain('JP')
    expect(new Set(codes).size).toBe(codes.length)
  })
})
