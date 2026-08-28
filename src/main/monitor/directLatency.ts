import { spawn } from 'node:child_process'
import { win32 } from 'node:path'

const PING_TIMEOUT_MS = 1500

export interface PingCommand {
  command: string
  args: string[]
}

/**
 * Ping 的参数在各系统上并不通用：Windows 的 -w 用毫秒，Linux 的 -W 用秒，
 * macOS 的 -W 又回到毫秒。始终用 argv 启动，host 再怎么写也不会进入 shell。
 */
export function pingCommand(
  target: string,
  platform = process.platform,
  systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
): PingCommand {
  if (platform === 'win32') {
    return {
      // 测试与打包会在非 Windows 宿主上模拟 Windows 参数；不能误用宿主的 path.join。
      command: win32.join(systemRoot, 'System32', 'PING.EXE'),
      args: ['-n', '1', '-w', '1000', target]
    }
  }
  if (platform === 'darwin') {
    return { command: '/sbin/ping', args: ['-n', '-c', '1', '-W', '1000', target] }
  }
  return { command: '/bin/ping', args: ['-n', '-c', '1', '-W', '1', target] }
}

/**
 * Ping 输出受系统语言影响，不能只认英文 `time=`。成功回包行和汇总行都会有
 * `= 12 ms` 或 `< 1 ms` 这个跨语言的数值形态；单次 Ping 的两者数值一致，取第一个即可。
 */
export function parsePingLatency(output: string): number | null {
  const match = /([=<])\s*(\d+(?:[.,]\d+)?)\s*ms\b/i.exec(output)
  if (!match) return null
  const value = Number(match[2].replace(',', '.'))
  if (!Number.isFinite(value) || value < 0) return null
  // Windows 常见 `time<1ms`；不能显示成 0ms（那会看起来像没有走网络）。
  return match[1] === '<' ? 1 : Math.round(value)
}

/**
 * 本机直接 ICMP 到配置的目标地址。它完全不经过 SSH/HTTP/SOCKS 代理，所以与
 * SSH 通道往返并列展示时，二者的差值就是当前实际连接链路额外引入的开销。
 *
 * ICMP 被云防火墙禁用、系统缺少 ping 命令或进程超时都只是“不可用”，绝不影响服务器监控。
 */
export function probeDirectLatency(target: string, signal?: AbortSignal): Promise<number | null> {
  const normalizedTarget = target.trim().replace(/^\[|\]$/g, '')
  if (!normalizedTarget || signal?.aborted) return Promise.resolve(null)

  return new Promise((resolve) => {
    const { command, args } = pingCommand(normalizedTarget)
    let output = ''
    let settled = false
    let timer: NodeJS.Timeout | null = null
    let child: ReturnType<typeof spawn> | null = null

    const finish = (value: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = (): void => {
      child?.kill()
      finish(null)
    }

    try {
      child = spawn(command, args, { shell: false, windowsHide: true })
    } catch {
      finish(null)
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      // 保护主进程：正常 ping 只有几行，异常程序也不能无限写入内存。
      output = `${output}${chunk.toString('utf8')}`.slice(-16 * 1024)
    })
    child.once('error', () => finish(null))
    child.once('close', (code) => finish(code === 0 ? parsePingLatency(output) : null))
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(abort, PING_TIMEOUT_MS)
    timer.unref()
  })
}
