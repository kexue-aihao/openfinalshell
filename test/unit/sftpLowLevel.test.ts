import { describe, expect, it } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import {
  readRemoteFile,
  sftpPosixRename,
  sftpRead,
  sftpStat,
  writeRemoteFile
} from '../../src/main/sftp/sftpLowLevel'

/**
 * 这批包装都是 ssh2 回调的薄壳，真链路验证在 test/integration/sftp.test.ts。
 * 这里只钉住几条**集成测试盖不到**的分支：
 *   - fixture 服务器不通告任何扩展，所以 posix-rename 的"支持"分支只能靠假 SFTPWrapper；
 *   - EOF 以 err 形式返回这条语义，坏了会在文件尾部静默截断，值得单独钉住；
 *   - stat 撒谎（伪文件报 0 字节）时 readRemoteFile 的兜底；
 *   - 'wx' 排他创建撞名的分支：真服务器上要造出"别人抢先占了这个名字"得先制造一个
 *     可被别人写的目录，fixture 里不好安全复现，用假对象直接回 SSH_FX_FAILURE 更干脆。
 */
function asSftp(fake: object): SFTPWrapper {
  return fake as unknown as SFTPWrapper
}

type ReadCb = (err: Error | undefined, bytesRead: number, buffer: Buffer, position: number) => void
type VoidCb = (err?: Error | null) => void
type OpenCb = (err: Error | undefined, handle: Buffer) => void

function sftpError(message: string, code?: number): Error {
  const err = new Error(message)
  if (code !== undefined) (err as Error & { code?: number }).code = code
  return err
}

interface MemSftp {
  sftp: SFTPWrapper
  opens: Array<{ path: string; flags: string; mode?: number }>
  reads: number
  writes: Array<{ offset: number; length: number }>
  closes: number
  /** 写入侧重放出的内容 */
  written: () => Buffer
}

/**
 * 内存假服务器：只实现 open/read/write/close/stat，够跑整文件读写。
 * occupied = "这个名字已经被占了"，只影响带 EXCL 的 open（真服务器的 EXCL 就是这个语义）。
 */
function memSftp(
  content: Buffer,
  reportedSize: number | null = content.length,
  occupied = false
): MemSftp {
  const state: MemSftp = {
    sftp: asSftp({}),
    opens: [],
    reads: 0,
    writes: [],
    closes: 0,
    written: () => Buffer.concat(parts.map((p) => p.chunk))
  }
  const parts: Array<{ offset: number; chunk: Buffer }> = []

  state.sftp = asSftp({
    open: (path: string, flags: string, a: unknown, b?: unknown): void => {
      const cb = (typeof a === 'function' ? a : b) as OpenCb
      state.opens.push({ path, flags, mode: typeof a === 'number' ? a : undefined })
      if (occupied && flags.includes('x')) {
        // SFTP v3 没有 EEXIST：OpenSSH 对 EXCL 冲突一律回 SSH_FX_FAILURE(4)，照抄这份难看
        cb(sftpError('Failure', 4), Buffer.alloc(0))
        return
      }
      cb(undefined, Buffer.from('handle'))
    },
    read: (
      _h: Buffer,
      buf: Buffer,
      offset: number,
      length: number,
      position: number,
      cb: ReadCb
    ): void => {
      state.reads++
      if (position >= content.length) {
        // 真服务器读到尾也是走 err 通道（code 1），假的必须照抄，否则测不到 EOF 语义
        cb(sftpError('EOF', 1), 0, buf, position)
        return
      }
      const slice = content.subarray(position, Math.min(position + length, content.length))
      slice.copy(buf, offset)
      cb(undefined, slice.length, buf, position)
    },
    write: (
      _h: Buffer,
      buf: Buffer,
      offset: number,
      length: number,
      position: number,
      cb: VoidCb
    ): void => {
      state.writes.push({ offset: position, length })
      parts.push({ offset: position, chunk: Buffer.from(buf.subarray(offset, offset + length)) })
      cb()
    },
    close: (_h: Buffer, cb: VoidCb): void => {
      state.closes++
      cb()
    },
    stat: (_p: string, cb: (err: Error | undefined, stats: unknown) => void): void => {
      if (reportedSize === null) return cb(sftpError('No such file', 2), undefined)
      cb(undefined, { size: reportedSize, mode: 0o100644 })
    }
  })
  return state
}

describe('sftpPosixRename', () => {
  it('服务器未通告扩展时 ssh2 同步 throw → 返回 false，且不偷偷退化成普通 rename', async () => {
    const fallback: string[] = []
    const sftp = asSftp({
      ext_openssh_rename: (): void => {
        throw new Error('Server does not support this extended request')
      },
      rename: (from: string, to: string, cb: VoidCb): void => {
        fallback.push(`${from}->${to}`)
        cb()
      },
      unlink: (path: string, cb: VoidCb): void => {
        fallback.push(`unlink ${path}`)
        cb()
      }
    })

    await expect(sftpPosixRename(sftp, '/tmp/a.new', '/tmp/a')).resolves.toBe(false)
    // 能力探测只许诚实报告，降级策略归调用方
    expect(fallback).toEqual([])
  })

  it('服务器支持时返回 true，路径先规范化', async () => {
    const calls: Array<[string, string]> = []
    const sftp = asSftp({
      ext_openssh_rename: (from: string, to: string, cb: VoidCb): void => {
        calls.push([from, to])
        cb()
      }
    })

    await expect(sftpPosixRename(sftp, '\\tmp\\a.ofsedit', '/tmp//a.txt')).resolves.toBe(true)
    expect(calls).toEqual([['/tmp/a.ofsedit', '/tmp/a.txt']])
  })

  it('回调里的错误照常抛出，不能被当成"不支持"吞掉', async () => {
    const sftp = asSftp({
      ext_openssh_rename: (_f: string, _t: string, cb: VoidCb): void => {
        cb(sftpError('Permission denied', 3))
      }
    })
    await expect(sftpPosixRename(sftp, '/a', '/b')).rejects.toThrow('Permission denied')
  })
})

describe('sftpRead 的 EOF 语义', () => {
  function readFails(err: Error): SFTPWrapper {
    return asSftp({
      read: (
        _h: Buffer,
        buf: Buffer,
        _o: number,
        _l: number,
        position: number,
        cb: ReadCb
      ): void => {
        cb(err, 0, buf, position)
      }
    })
  }

  it('EOF(code 1) 按 0 字节处理而不是报错', async () => {
    const bytes = await sftpRead(readFails(sftpError('EOF', 1)), Buffer.alloc(0), Buffer.alloc(8), 8, 0)
    expect(bytes).toBe(0)
  })

  it('没带 code 但消息是 EOF 的也认（老服务器/不同实现）', async () => {
    const bytes = await sftpRead(readFails(sftpError('Unexpected EOF')), Buffer.alloc(0), Buffer.alloc(8), 8, 0)
    expect(bytes).toBe(0)
  })

  it('真错误必须抛，不能混进 EOF 分支变成静默截断', async () => {
    await expect(
      sftpRead(readFails(sftpError('Permission denied', 3)), Buffer.alloc(0), Buffer.alloc(8), 8, 0)
    ).rejects.toThrow('Permission denied')
  })
})

describe('sftpStat', () => {
  it('失败给 null 而不是抛', async () => {
    const sftp = asSftp({
      stat: (_p: string, cb: (err: Error | undefined, stats: unknown) => void): void => {
        cb(sftpError('No such file', 2), undefined)
      }
    })
    await expect(sftpStat(sftp, '/nope')).resolves.toBeNull()
  })

  it('成功透传 Stats', async () => {
    const mem = memSftp(Buffer.alloc(42))
    const stats = await sftpStat(mem.sftp, '/x')
    expect(stats?.size).toBe(42)
  })
})

describe('readRemoteFile', () => {
  // 80KB 跨 32KB 块 → 至少 3 次数据读，能对着"只读一块就返回"的实现报红
  const big = Buffer.from(Array.from({ length: 80 * 1024 }, (_, i) => i % 251))

  it('循环读到 EOF，内容完整且句柄归还', async () => {
    const mem = memSftp(big)
    const got = await readRemoteFile(mem.sftp, '/big.bin', 1024 * 1024)
    expect(got.equals(big)).toBe(true)
    expect(mem.reads).toBeGreaterThanOrEqual(3)
    expect(mem.closes).toBe(1)
  })

  it('stat 就能判超限时直接拒，不开句柄', async () => {
    const mem = memSftp(big)
    await expect(readRemoteFile(mem.sftp, '/big.bin', 8 * 1024)).rejects.toThrow(/太大/)
    expect(mem.opens).toEqual([])
  })

  it('stat 撒谎报 0 字节（伪文件）时靠边读边累计兜底，句柄照样关掉', async () => {
    const mem = memSftp(big, 0)
    await expect(readRemoteFile(mem.sftp, '/proc/fake', 8 * 1024)).rejects.toThrow(/太大/)
    expect(mem.closes).toBe(1)
  })

  it('stat 失败（无权限/断链）不妨碍尝试读', async () => {
    const mem = memSftp(Buffer.from('hi'), null)
    expect((await readRemoteFile(mem.sftp, '/x', 1024)).toString()).toBe('hi')
  })
})

describe('writeRemoteFile', () => {
  it('open 时就带上 mode（不留"短暂全局可写"的窗口）', async () => {
    const mem = memSftp(Buffer.alloc(0))
    await writeRemoteFile(mem.sftp, '\\tmp\\a.txt', Buffer.from('x'), 0o600)
    expect(mem.opens).toEqual([{ path: '/tmp/a.txt', flags: 'w', mode: 0o600 }])
  })

  it('大内容分块写，offset 连续且内容一致', async () => {
    const payload = Buffer.from(Array.from({ length: 70 * 1024 }, (_, i) => (i * 7) % 253))
    const mem = memSftp(Buffer.alloc(0))
    await writeRemoteFile(mem.sftp, '/tmp/b.bin', payload, 0o644)

    expect(mem.writes.length).toBeGreaterThanOrEqual(3)
    let expectedOffset = 0
    for (const w of mem.writes) {
      expect(w.offset).toBe(expectedOffset)
      expectedOffset += w.length
    }
    expect(expectedOffset).toBe(payload.length)
    expect(mem.written().equals(payload)).toBe(true)
    expect(mem.closes).toBe(1)
  })

  it('空内容仍走一遍 open/close（靠 w 的截断把远端清空）', async () => {
    const mem = memSftp(Buffer.alloc(0))
    await writeRemoteFile(mem.sftp, '/tmp/empty', Buffer.alloc(0), 0o644)
    expect(mem.writes).toEqual([])
    expect(mem.opens).toHaveLength(1)
    expect(mem.closes).toBe(1)
  })

  /**
   * 临时文件名 `.<name>.ofsedit-<8hex>` 是完全可预测的，目标目录里有写权限的另一个用户
   * 能预先摆一个同名符号链接，让这次写入（写入方常常是 root）穿到他选的路径去。
   * 'wx' 的 EXCL 是唯一能挡住这个的东西 —— 这两条就是钉住它别被"顺手改回 'w'"抹掉。
   */
  it("flags 传 'wx' 时 open 就得是 'wx'（别人预放的同名符号链接写不进来）", async () => {
    const mem = memSftp(Buffer.alloc(0))
    const tmp = '/etc/.nginx.conf.ofsedit-1a2b3c4d'
    await writeRemoteFile(mem.sftp, tmp, Buffer.from('x'), 0o600, 'wx')
    expect(mem.opens).toEqual([{ path: tmp, flags: 'wx', mode: 0o600 }])
  })

  it("不传 flags 时仍是 'w'（现有调用方的覆盖语义一个字节不改）", async () => {
    const mem = memSftp(Buffer.alloc(0), 0, true) // 目标已存在：'w' 该照样截断着写
    await writeRemoteFile(mem.sftp, '/tmp/known.txt', Buffer.from('hi'), 0o644)
    expect(mem.opens.map((o) => o.flags)).toEqual(['w'])
    expect(mem.written().toString()).toBe('hi')
  })

  it("'wx' 撞上已存在项必须 reject，不许静默退化成 'w' 再来一次", async () => {
    const mem = memSftp(Buffer.alloc(0), 0, true)
    const tmp = '/etc/.nginx.conf.ofsedit-1a2b3c4d'
    await expect(writeRemoteFile(mem.sftp, tmp, Buffer.from('x'), 0o600, 'wx')).rejects.toThrow(
      'Failure'
    )
    // 只许试这一次：多出一次 flags 'w' 的 open 就是把 EXCL 这道门拆了
    expect(mem.opens.map((o) => o.flags)).toEqual(['wx'])
    expect(mem.writes).toEqual([])
    expect(mem.closes).toBe(0) // open 没成功，没有句柄可关
  })
})
