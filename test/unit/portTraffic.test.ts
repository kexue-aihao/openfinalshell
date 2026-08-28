import { describe, expect, it } from 'vitest'
import { PortTrafficCollector, parsePortCounters } from '../../src/main/monitor/PortTrafficCollector'
import { buildPortTrafficFrame } from '../../src/main/monitor/portTrafficScript'

describe('端口流量采样', () => {
  it('只接收严格的聚合端口计数，畸形或越界远端输出一律丢弃', () => {
    const ports = parsePortCounters(`
22 2 1200 3400
443 18 999999 1234567
70000 1 1 1
80 -1 0 0
53 1 bad 4
80 1 9007199254740992 1
8080 3 90 120 trailing
`)

    expect([...ports]).toEqual([
      [22, { connections: 2, rxBytes: 1200, txBytes: 3400 }],
      [443, { connections: 18, rxBytes: 999999, txBytes: 1234567 }]
    ])
  })

  it('服务器侧先按端口聚合 ss 的 TCP 字节计数，而不是把完整 socket 表传回', () => {
    const frame = buildPortTrafficFrame(7)
    expect(frame).toContain('ss -tinH')
    expect(frame).toContain('bytes_sent:')
    expect(frame).toContain('bytes_received:')
    expect(frame).toContain('printf "%s %d %.0f %.0f')
    expect(frame).toContain('@@OFS:BEGIN:7@@')
    expect(frame).toContain('@@OFS:END:7@@')
    expect(frame).toContain('@@OFS:NOSS@@')
  })

  it('同一 SSH 数据块里的过期帧不会遮蔽当前采样帧', async () => {
    const collector = new PortTrafficCollector(
      'session-1',
      async () => {
        throw new Error('not opened in this parser test')
      },
      { onSnapshot: () => {}, onState: () => {} }
    )
    const result = new Promise<string | null>((resolve) => {
      ;(collector as unknown as { pending: { seq: number; resolve: (body: string | null) => void } }).pending = {
        seq: 2,
        resolve
      }
    })

    ;(collector as unknown as { onData: (chunk: Buffer) => void }).onData(Buffer.from([
      '@@OFS:BEGIN:1@@', '@@OFS:PORTS@@', '22 1 1 2', '@@OFS:END:1@@',
      '@@OFS:BEGIN:2@@', '@@OFS:PORTS@@', '443 2 3 4', '@@OFS:END:2@@', ''
    ].join('\n')))

    await expect(result).resolves.toBe('@@OFS:PORTS@@\n443 2 3 4\n')
  })
})
