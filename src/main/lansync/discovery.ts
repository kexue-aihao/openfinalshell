import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import type { LanSyncDevice } from '@shared/types'
import { scopedLogger } from '../utils/logger'
import {
  DISCOVERY_GROUP,
  DISCOVERY_PORT,
  SYNC_PROTO,
  decodeDiscovery,
  encodeDiscovery
} from './protocol'

const log = scopedLogger('lansync')

/**
 * UDP 发现 —— 仓内第一处 node:dgram。
 *
 * 发现是**尽力而为**：所有 socket 错误只记日志、不抛。组播被 AP 隔离 / 交换机 IGMP
 * snooping 吞掉是企业网常态，所以广播（255.255.255.255）是并列的第二条腿，而
 * 「手输 IP:端口」是永远兜底的第三条 —— 发现层整个缺席也不影响 TCP 传输。
 */

/** 本机所有非回环 IPv4 网卡地址（组播要逐块网卡绑定，手输路径也要展示这些） */
export function localIPv4s(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

export interface AnnounceInfo {
  deviceId: string
  deviceName: string
  appVersion: string
  tcpPort: number
  sessionId: string
}

/**
 * 接收态期间开着的应答器：收到 probe 就单播 announce 回去，另每 2s 主动组播通告
 * （补偿 probe 丢包）。info 用函数取而不是传值 —— 烧码换 sessionId 后通告要跟着变。
 */
export function startResponder(info: () => AnnounceInfo): { close: () => void } {
  const sock = createSocket({ type: 'udp4', reuseAddr: true })

  sock.on('error', (err) => log.warn(`responder socket error: ${err.message}`))

  sock.on('message', (buf, rinfo) => {
    const msg = decodeDiscovery(buf)
    if (msg?.kind !== 'probe') return
    // 单播直接回源：比等下一轮组播快，且不打扰组里其它设备
    const reply = encodeDiscovery({ magic: 'OFSSYNC1', proto: SYNC_PROTO, kind: 'announce', ...info() })
    sock.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) log.warn(`announce reply failed: ${err.message}`)
    })
  })

  sock.bind(DISCOVERY_PORT, () => {
    for (const addr of localIPv4s()) {
      try {
        sock.addMembership(DISCOVERY_GROUP, addr)
      } catch (err) {
        // 某块网卡加组失败不影响其它网卡（VPN 虚拟网卡常拒绝组播）
        log.warn(`addMembership on ${addr} failed: ${(err as Error).message}`)
      }
    }
  })

  const timer = setInterval(() => {
    const announce = encodeDiscovery({
      magic: 'OFSSYNC1',
      proto: SYNC_PROTO,
      kind: 'announce',
      ...info()
    })
    for (const addr of localIPv4s()) {
      try {
        sock.setMulticastInterface(addr)
        sock.send(announce, DISCOVERY_PORT, DISCOVERY_GROUP)
      } catch (err) {
        log.warn(`periodic announce on ${addr} failed: ${(err as Error).message}`)
      }
    }
  }, 2000)
  timer.unref?.()

  return {
    close: () => {
      clearInterval(timer)
      try {
        sock.close()
      } catch {
        /* 已关就算了 */
      }
    }
  }
}

/**
 * 扫描处于接收态的设备。逐网卡各开一个 socket 发 probe（组播 + 广播兜底），
 * 在窗口内收集 announce，按 deviceId+地址+端口去重、滤掉自己。
 */
export function scanDevices(selfDeviceId: string, timeoutMs = 2500): Promise<LanSyncDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, LanSyncDevice>()
    const sockets: Socket[] = []
    const addrs = localIPv4s()
    // 没有可用网卡（离线）时也别挂着，空手返回
    if (addrs.length === 0) {
      resolve([])
      return
    }

    const probe = encodeDiscovery({
      magic: 'OFSSYNC1',
      proto: SYNC_PROTO,
      kind: 'probe',
      deviceId: selfDeviceId,
      deviceName: ''
    })

    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      for (const s of sockets) {
        try {
          s.close()
        } catch {
          /* ignore */
        }
      }
      resolve([...found.values()])
    }

    for (const addr of addrs) {
      const sock = createSocket({ type: 'udp4', reuseAddr: true })
      sockets.push(sock)
      sock.on('error', (err) => log.warn(`scan socket ${addr} error: ${err.message}`))
      sock.on('message', (buf, rinfo) => {
        const msg = decodeDiscovery(buf)
        if (msg?.kind !== 'announce' || msg.deviceId === selfDeviceId) return
        // 用 announce 载荷 + 收包源地址组键去重（回包源地址才是能连上的那个）
        const key = `${msg.deviceId}@${rinfo.address}:${msg.tcpPort}`
        if (!found.has(key)) {
          found.set(key, {
            deviceId: msg.deviceId,
            deviceName: msg.deviceName,
            appVersion: msg.appVersion,
            address: rinfo.address,
            tcpPort: msg.tcpPort
          })
        }
      })
      sock.bind(0, addr, () => {
        try {
          sock.setBroadcast(true)
          sock.setMulticastInterface(addr)
        } catch {
          /* 某些网卡不支持，继续尝试发送 */
        }
        // 组播 + 广播两条腿都发
        sock.send(probe, DISCOVERY_PORT, DISCOVERY_GROUP, (err) => {
          if (err) log.warn(`multicast probe on ${addr} failed: ${err.message}`)
        })
        sock.send(probe, DISCOVERY_PORT, '255.255.255.255', (err) => {
          if (err) log.warn(`broadcast probe on ${addr} failed: ${err.message}`)
        })
      })
    }

    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
  })
}
