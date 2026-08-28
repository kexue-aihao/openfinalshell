import { describe, expect, it } from 'vitest'
import type { PortTrafficSnapshot } from '../../src/shared/types'
import { PortTrafficCollector, parsePortCounters } from '../../src/main/monitor/PortTrafficCollector'
import { buildPortTrafficFrame } from '../../src/main/monitor/portTrafficScript'

describe('端口流量采样', () => {
  it('只接收严格的聚合端口计数，畸形或越界远端输出一律丢弃', () => {
    const ports = parsePortCounters(`
22 2 1200 3400 2
443 18 999999 1234567 0
70000 1 1 1 1
80 -1 0 0 0
53 1 bad 4 1
80 1 9007199254740992 1 1
443 2 1 2 3
8080 3 90 120 3 trailing
`)

    expect([...ports]).toEqual([
      [22, { connections: 2, rxBytes: 1200, txBytes: 3400, counterConnections: 2 }],
      [443, { connections: 18, rxBytes: 999999, txBytes: 1234567, counterConnections: 0 }]
    ])
  })

  it('服务器侧先按端口聚合 ss 的 TCP 字节计数，而不是把完整 socket 表传回', () => {
    const frame = buildPortTrafficFrame(7)
    expect(frame).toContain('ss -ntinH')
    expect(frame).not.toContain('ss -tinH 2>/dev/null')
    expect(frame).toContain('bytes_sent:')
    expect(frame).toContain('bytes_received:')
    expect(frame).toContain('counter_conns[p] + 0')
    // String.raw 中必须只留下一个反斜杠，供远端 awk 解释为真正的换行。
    expect(frame).toContain('printf "%s %d %.0f %.0f %d\\n",')
    expect(frame).not.toContain('printf "%s %d %.0f %.0f %d\\\\n",')
    expect(frame).not.toContain('\r')
    expect(frame).toContain('@@OFS:BEGIN:7@@')
    expect(frame).toContain('@@OFS:END:7@@')
    expect(frame).toContain('@@OFS:NOSS@@')
  })

  it('ss 缺少双向字节计数时仍发布端口和连接数，并将速率标为不可用', () => {
    const snapshots: PortTrafficSnapshot[] = []
    const collector = new PortTrafficCollector(
      'session-1',
      async () => {
        throw new Error('not opened in this collector test')
      },
      { onSnapshot: (snapshot) => snapshots.push(snapshot), onState: () => {} }
    )

    ;(collector as unknown as { publish: (counters: ReturnType<typeof parsePortCounters>) => void }).publish(
      parsePortCounters('50035 1 0 0 0\n443 3 0 0 0')
    )

    expect(snapshots[0].ports).toEqual([
      { port: 443, connections: 3, ratesAvailable: false, rxBps: 0, txBps: 0 },
      { port: 50035, connections: 1, ratesAvailable: false, rxBps: 0, txBps: 0 }
    ])
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
