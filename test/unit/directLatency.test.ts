import { describe, expect, it } from 'vitest'
import { parsePingLatency, pingCommand } from '../../src/main/monitor/directLatency'

describe('直连 Ping 延迟', () => {
  it('为 Windows、Linux 和 macOS 生成各自正确的一次 Ping 参数', () => {
    expect(pingCommand('203.0.113.9', 'win32', 'C:\\Windows')).toEqual({
      command: 'C:\\Windows\\System32\\PING.EXE',
      args: ['-n', '1', '-w', '1000', '203.0.113.9']
    })
    expect(pingCommand('203.0.113.9', 'linux')).toEqual({
      command: '/bin/ping',
      args: ['-n', '-c', '1', '-W', '1', '203.0.113.9']
    })
    expect(pingCommand('203.0.113.9', 'darwin')).toEqual({
      command: '/sbin/ping',
      args: ['-n', '-c', '1', '-W', '1000', '203.0.113.9']
    })
  })

  it('解析不同系统与语言的成功回包，不把 time<1ms 伪装成 0ms', () => {
    expect(parsePingLatency('64 bytes from 203.0.113.9: icmp_seq=1 ttl=52 time=42.6 ms')).toBe(43)
    expect(parsePingLatency('Reply from 203.0.113.9: bytes=32 time<1ms TTL=57')).toBe(1)
    expect(parsePingLatency('来自 203.0.113.9 的回复: 字节=32 时间=18ms TTL=57')).toBe(18)
    expect(parsePingLatency('Antwort von 203.0.113.9: Bytes=32 Zeit=27ms TTL=57')).toBe(27)
  })

  it('丢包和非延迟输出统一视为不可用', () => {
    expect(parsePingLatency('Request timed out.')).toBeNull()
    expect(parsePingLatency('Destination Host Unreachable')).toBeNull()
  })
})
