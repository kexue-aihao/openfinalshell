import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { MonitorSnapshot, ProfileDraft } from '@shared/types'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { monitorManager } from '../../src/main/monitor/MonitorManager'

const PORT = 2250

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
function eventsOf<K extends keyof EventMap>(channel: K): Array<EventMap[K]> {
  return events.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
}
function snapshots(): MonitorSnapshot[] {
  return eventsOf('monitor:data').map((e) => e.snapshot)
}
async function waitFor(pred: () => boolean, ms = 20000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 40))
  }
}

let server: ChildProcess
let sessionId = ''
let profileId = ''

function draft(): ProfileDraft {
  return {
    name: 'monitor-fixture',
    groupId: null,
    host: '127.0.0.1',
    port: PORT,
    username: 'test',
    auth: { method: 'password', password: 'test123' },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 10000,
      legacyAlgorithms: false,
      autoReconnect: false,
      monitorEnabled: true,
      compress: false
    }
  }
}

beforeAll(async () => {
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  server = spawn(process.execPath, ['test/fixtures/testSshServer.mjs', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 10000)
    server.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  const trust = setInterval(() => {
    for (const p of eventsOf('session:prompt')) {
      if (p.kind === 'hostkey-new' || p.kind === 'hostkey-changed') {
        promptBroker.reply({ requestId: p.requestId, ok: true, remember: true })
      }
    }
  }, 20)
  const profile = saveProfile(draft())
  profileId = profile.id
  ;({ sessionId } = await sshManager.open(profile.id))
  clearInterval(trust)
})

afterAll(() => {
  monitorManager.stopAll()
  sshManager.closeAll()
  if (profileId) deleteProfile(profileId)
  server?.kill()
})

describe('监控采集', () => {
  it('start 返回静态信息（uname/os-release/nproc/ip 组合）', async () => {
    const info = await monitorManager.start(sessionId, 1000)
    expect(info).not.toBeNull()
    expect(info!.hostname).toBe('fixture-host')
    expect(info!.kernel).toBe('5.15.0-91-generic')
    expect(info!.arch).toBe('x86_64')
    expect(info!.distro).toBe('Ubuntu 22.04.3 LTS')
    expect(info!.cpuCores).toBe(2)
    expect(info!.ips).toEqual(['10.0.0.5'])
    expect(eventsOf('monitor:state').at(-1)?.state).toBe('running')
  })

  it('首帧只建基线，第二帧起才有差分数据', async () => {
    await waitFor(() => snapshots().length >= 2, 15000, 'two snapshots')
    const snap = snapshots().at(-1)!

    // CPU：fixture 每 tick 总量 +300、idle +100 → 约 66.7%
    expect(snap.cpu.usagePct).toBeGreaterThan(50)
    expect(snap.cpu.usagePct).toBeLessThanOrEqual(100)
    expect(snap.cpu.perCore.length).toBe(2)
    expect(snap.cpu.loadAvg).toEqual([0.52, 0.31, 0.24])

    // 内存来自 meminfo（非计数器，首帧即有）
    expect(snap.mem.totalKb).toBe(8039152)
    expect(snap.mem.usedKb).toBe(8039152 - 6842108)
    expect(snap.mem.swapUsedKb).toBe(2097148 - 2000000)

    // 网络：eth0 每 tick +1MB / +512KB，lo 被过滤
    const eth0 = snap.net.find((n) => n.iface === 'eth0')!
    expect(eth0).toBeTruthy()
    expect(snap.net.some((n) => n.iface === 'lo')).toBe(false)
    expect(eth0.rxBps).toBeGreaterThan(0)
    expect(eth0.txBps).toBeGreaterThan(0)

    // 磁盘 IO：只统计整盘 sda，不含分区 sda1
    expect(snap.diskIo.map((d) => d.dev)).toEqual(['sda'])
    expect(snap.diskIo[0].readBps).toBeGreaterThan(0)

    expect(snap.uptimeSec).toBeGreaterThan(0)

    // 延迟打点：写帧→首见 BEGIN 哨兵。fixture 在本机，几毫秒以内，但必须存在且非负
    expect(snap.latencyMs).toBeTypeOf('number')
    expect(snap.latencyMs!).toBeGreaterThanOrEqual(0)
    expect(snap.latencyMs!).toBeLessThan(5000)
  })

  it('df 与进程列表按 tick 轮换采集（非每帧都带）', async () => {
    await waitFor(
      () => snapshots().some((s) => s.diskFs !== null),
      20000,
      'a snapshot carrying df'
    )
    const withDf = snapshots().find((s) => s.diskFs !== null)!
    expect(withDf.diskFs!.map((f) => f.mount)).toEqual(['/', '/data'])
    expect(withDf.diskFs!.find((f) => f.mount === '/data')!.usePct).toBeGreaterThan(90)
    expect(withDf.topProcs?.[0]).toEqual({ pid: 1234, cpuPct: 45.2, memPct: 3.1, name: 'node' })

    // 大多数帧不带 df（每 5 tick 一次）
    expect(snapshots().some((s) => s.diskFs === null)).toBe(true)
  })

  it('连接数每帧都有（sockstat 是 O(1)），TCP 状态明细只在低频 tick 有', async () => {
    // conns 每帧都该有 —— 这是选 sockstat 而不是 /proc/net/tcp 的直接收益：
    // 输出恒定十几字节，可以每 tick 采，首屏不用等到第 6 帧
    const all = snapshots()
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all.every((s) => s.conns !== null)).toBe(true)
    // fixture：TCP 12+4、UDP 6+1、tw 3、sockets 337
    expect(all.at(-1)!.conns).toEqual({
      socketsUsed: 337,
      tcpInuse: 16,
      tcpOrphan: 0,
      tcpTw: 3,
      udpInuse: 7
    })

    // 明细跟 df 同一档，所以"有的帧带、有的帧不带"
    await waitFor(
      () => snapshots().some((s) => s.tcpStates !== undefined),
      20000,
      'a snapshot carrying tcpStates'
    )
    expect(snapshots().find((s) => s.tcpStates)!.tcpStates).toEqual({
      ESTABLISHED: 31,
      LISTEN: 9,
      TIME_WAIT: 3,
      CLOSE_WAIT: 1
    })
    expect(snapshots().some((s) => s.tcpStates === undefined)).toBe(true)
    // best-effort 的底线：明细这一段无论如何都不能把面板打成 failed
    expect(eventsOf('monitor:state').filter((s) => s.state === 'failed')).toHaveLength(0)
  })

  it('setInterval 改频率不重启通道', async () => {
    const before = snapshots().length
    monitorManager.setInterval(sessionId, 1000)
    await waitFor(() => snapshots().length > before, 10000, 'snapshots continue')
    expect(eventsOf('monitor:state').filter((s) => s.state === 'failed')).toHaveLength(0)
  })

  it('stop 后不再产生快照', async () => {
    monitorManager.stop(sessionId)
    const after = snapshots().length
    await new Promise((r) => setTimeout(r, 1500))
    expect(snapshots().length).toBe(after)
    expect(eventsOf('monitor:state').at(-1)?.state).toBe('stopped')
  })

  it('监控通道不干扰终端会话', async () => {
    await monitorManager.start(sessionId, 1000)
    const { termId } = await sshManager.openShell(sessionId, 80, 24)
    const shell = sshManager.getTerm(termId)!
    shell.write('echo monitor-coexist\r')
    await waitFor(
      () =>
        eventsOf('term:data')
          .filter((e) => e.termId === termId)
          .map((e) => Buffer.from(e.data).toString('utf8'))
          .join('')
          .includes('monitor-coexist'),
      10000,
      'terminal still works'
    )
    const before = snapshots().length
    await waitFor(() => snapshots().length > before, 10000, 'monitoring still running')
    sshManager.closeTerm(termId)
  })
})
