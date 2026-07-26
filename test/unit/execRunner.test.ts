import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { execOnce, parseRcSentinel } from '../../src/main/ssh/ExecRunner'

/** execOnce 只用到通道的 data / stderr.data / exit / close 与 close()，假一个就够 */
class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  closed = false
  close(): void {
    this.closed = true
  }
  /** 便于测试里模拟一段输出 */
  push(text: string): void {
    this.emit('data', Buffer.from(text, 'utf8'))
  }
  asChannel(): ClientChannel {
    return this as unknown as ClientChannel
  }
}

function fakeConn(): { conn: { execChannel: (cmd: string) => Promise<ClientChannel> }; channel: FakeChannel; commands: string[] } {
  const channel = new FakeChannel()
  const commands: string[] = []
  return {
    channel,
    commands,
    conn: {
      execChannel: (cmd: string) => {
        commands.push(cmd)
        return Promise.resolve(channel.asChannel())
      }
    }
  }
}

describe('parseRcSentinel', () => {
  it('没有哨兵 → code 为 null，正文原样', () => {
    expect(parseRcSentinel('hello\n')).toEqual({ body: 'hello\n', code: null })
    expect(parseRcSentinel('')).toEqual({ body: '', code: null })
  })

  it('有哨兵 → 取出退出码并剥掉哨兵与它前面那个换行', () => {
    expect(parseRcSentinel('OFSLEFT:/a\n\n@@OFS:RC:0@@\n')).toEqual({
      body: 'OFSLEFT:/a\n',
      code: 0
    })
    expect(parseRcSentinel('\n@@OFS:RC:1@@\n')).toEqual({ body: '', code: 1 })
    expect(parseRcSentinel('\n@@OFS:RC:255@@\n').code).toBe(255)
  })

  it('正文本来的空行不会被多剥掉（只去哨兵前那一个换行）', () => {
    expect(parseRcSentinel('a\n\n\n@@OFS:RC:0@@\n').body).toBe('a\n\n')
  })

  /** 我们的哨兵是追加在脚本末尾的，所以正文里万一也出现同样字样，赢的必须是最后那个 */
  it('多个哨兵 → 最后一个赢', () => {
    expect(parseRcSentinel('@@OFS:RC:1@@\nx\n@@OFS:RC:0@@\n').code).toBe(0)
    expect(parseRcSentinel('@@OFS:RC:0@@\nx\n@@OFS:RC:2@@\n').code).toBe(2)
  })

  it('垃圾哨兵当没看见（非数字、超出 0–255）', () => {
    expect(parseRcSentinel('@@OFS:RC:abc@@\n').code).toBe(null)
    expect(parseRcSentinel('@@OFS:RC:@@\n').code).toBe(null)
    expect(parseRcSentinel('@@OFS:RC:999@@\n').code).toBe(null)
    // 一个合法的 + 一个越界的 → 合法那个仍然算
    expect(parseRcSentinel('@@OFS:RC:3@@\n@@OFS:RC:99999@@\n').code).toBe(3)
  })
})

describe('execOnce', () => {
  it('命令经 wrapShellScript 包过，并在脚本末尾追加 RC 哨兵', async () => {
    const { conn, channel, commands } = fakeConn()
    const pending = execOnce(conn, 'rm -rf -- /data/x')
    await Promise.resolve()
    channel.push('\n@@OFS:RC:0@@\n')
    channel.emit('close')
    await pending

    expect(commands).toHaveLength(1)
    expect(commands[0].startsWith("env LC_ALL=C LANG=C sh -c '")).toBe(true)
    expect(commands[0]).toContain('rm -rf -- /data/x')
    // 哨兵那段必须在，且脚本自己**不能** exit（否则哨兵永远不执行）
    expect(commands[0]).toContain('__ofs_rc=$?')
    expect(commands[0]).toContain('@@OFS:RC:%s@@')
  })

  it('正常一趟：stdout 剥掉哨兵、stderr 带回、code 来自哨兵', async () => {
    const { conn, channel } = fakeConn()
    const pending = execOnce(conn, 'true')
    await Promise.resolve()
    channel.push('OFSLEFT:/data/a\n')
    channel.stderr.emit('data', Buffer.from("rm: cannot remove '/data/a': Permission denied\n"))
    channel.push('\n@@OFS:RC:1@@\n')
    channel.emit('close')

    const result = await pending
    expect(result.stdout).toBe('OFSLEFT:/data/a\n')
    expect(result.stderr).toContain('Permission denied')
    expect(result.code).toBe(1)
    expect(result.truncated).toBe(false)
  })

  /** exit 事件按 SSH 规范是可选的，所以哨兵是主、事件是兜底 */
  it('哨兵优先于 exit 事件', async () => {
    const { conn, channel } = fakeConn()
    const pending = execOnce(conn, 'true')
    await Promise.resolve()
    channel.push('\n@@OFS:RC:7@@\n')
    channel.emit('exit', 0)
    channel.emit('close')
    expect((await pending).code).toBe(7)
  })

  it('没有哨兵时退回 exit 事件', async () => {
    const { conn, channel } = fakeConn()
    const pending = execOnce(conn, 'true')
    await Promise.resolve()
    channel.emit('exit', 3)
    channel.emit('close')
    expect((await pending).code).toBe(3)
  })

  it('两者都没有 → null（一律当"未知"，永不当成功）', async () => {
    const { conn, channel } = fakeConn()
    const pending = execOnce(conn, 'true')
    await Promise.resolve()
    channel.emit('close')
    expect((await pending).code).toBe(null)
  })

  /**
   * 截断保留**头部**（有用的行都在前面），退出码另走一个尾部滚动窗 ——
   * 于是"输出被截断"和"拿不到退出码"是两件独立的事。
   * MonitorCollector 当年就是超限保留尾部、把开头的哨兵丢了，整帧必然超时。
   */
  it('超出上限时保留**头部**，但退出码仍然拿得到', async () => {
    const { conn, channel } = fakeConn()
    const pending = execOnce(conn, 'true', { maxBytes: 64 })
    await Promise.resolve()
    // 先来一行"有用的"（真实场景里 OFSLEFT 都在前面），再让后面的垃圾冲破上限
    channel.push('OFSLEFT:/data/first\n')
    channel.push('z'.repeat(200))
    channel.push('\n@@OFS:RC:0@@\n')
    channel.emit('close')

    const result = await pending
    expect(result.truncated).toBe(true)
    expect(result.stdout).toHaveLength(64)
    // 改成"保留尾部"的话，这一行是第一个被丢掉的
    expect(result.stdout.startsWith('OFSLEFT:/data/first\n')).toBe(true)
    // 而退出码走的是另一个尾部滚动窗，所以截断不影响它
    expect(result.code).toBe(0)
  })

  it('超时会杀通道并抛错（一个永不返回的 exec 会一直占着一个 session 通道）', async () => {
    const { conn, channel } = fakeConn()
    await expect(execOnce(conn, 'sleep 999', { timeoutMs: 20 })).rejects.toThrow(/超时/)
    expect(channel.closed).toBe(true)
  })

  it('超时之后迟到的 close 不会二次收尾', async () => {
    const { conn, channel } = fakeConn()
    const pending = execOnce(conn, 'sleep 999', { timeoutMs: 20 })
    await expect(pending).rejects.toThrow(/超时/)
    // 不抛、不改变任何已 settle 的结果
    expect(() => channel.emit('close')).not.toThrow()
  })
})
