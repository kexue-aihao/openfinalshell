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

/**
 * 并发窗口那一段。
 *
 * 上面那个 memSftp 的回调是**同步**的，于是请求虽然是并发发出的、完成顺序却和发出顺序一致 ——
 * 它照不出并发引入的任何问题（这也是为什么改成并发之后它原封不动全绿）。
 * 这一段自带一个**异步且刻意乱序完成**的假服务器，并且按 offset 重组写入（真服务器的
 * 定位写就是这个语义），才测得到"乱序完成后内容还对不对"。
 */
describe('整文件读写的并发窗口', () => {
  interface AsyncMem {
    sftp: SFTPWrapper
    /** 按 offset 重组后的内容（真服务器的定位写语义） */
    assembled: () => Buffer
    reads: number
    closes: number
    maxInFlight: number
  }

  /**
   * @param content 真实内容
   * @param reportedSize stat 报的大小（可以与真实不符，用来模拟伪文件/文件变短）
   * @param shortRead 每次 read 最多只给请求量的一半（模拟 SFTP 允许的短读）
   * @param failAt 写到这个 offset 时报错（模拟中途失败）
   */
  function asyncMem(
    content: Buffer,
    reportedSize: number | null = content.length,
    opts: { shortRead?: boolean; failWriteAt?: number; contentAt?: () => Buffer } = {}
  ): AsyncMem {
    const parts = new Map<number, Buffer>()
    let inFlight = 0
    const state: AsyncMem = {
      sftp: asSftp({}),
      reads: 0,
      closes: 0,
      maxInFlight: 0,
      assembled: () => {
        let end = 0
        for (const [off, buf] of parts) end = Math.max(end, off + buf.length)
        const out = Buffer.alloc(end)
        for (const [off, buf] of parts) buf.copy(out, off)
        return out
      }
    }
    // 乱序：延迟随 position 反相关，靠后的片先回来
    const later = (position: number, fn: () => void): void => {
      inFlight++
      state.maxInFlight = Math.max(state.maxInFlight, inFlight)
      setTimeout(
        () => {
          inFlight--
          fn()
        },
        1 + ((0xffff - (position % 0xffff)) % 5)
      )
    }

    state.sftp = asSftp({
      open: (_p: string, _f: string, a: unknown, b?: unknown): void => {
        const cb = (typeof a === 'function' ? a : b) as OpenCb
        cb(undefined, Buffer.from('h'))
      },
      read: (_h: Buffer, buf: Buffer, offset: number, length: number, position: number, cb: ReadCb): void => {
        state.reads++
        // contentAt 让"这一次读看得见多少内容"随调用次数变化（模拟正在被追加写的文件）
        const view = opts.contentAt ? opts.contentAt() : content
        later(position, () => {
          if (position >= view.length) return cb(sftpError('EOF', 1), 0, buf, position)
          // 短读给**固定**的 8KB，不是"剩余量的一半"——后者会退化成几何级数（一片要十几次读），
          // 那是个比真实服务器苛刻得多的模型，会让往返次数的判据失去意义
          const want = opts.shortRead ? Math.min(length, 8 * 1024) : length
          const slice = view.subarray(position, Math.min(position + want, view.length))
          slice.copy(buf, offset)
          cb(undefined, slice.length, buf, position)
        })
      },
      write: (_h: Buffer, buf: Buffer, offset: number, length: number, position: number, cb: VoidCb): void => {
        later(position, () => {
          if (opts.failWriteAt !== undefined && position === opts.failWriteAt) {
            return cb(sftpError('Permission denied', 3))
          }
          parts.set(position, Buffer.from(buf.subarray(offset, offset + length)))
          cb()
        })
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

  /**
   * 700KB → 22 片。**必须多于并发上限 16**，否则"上限有没有生效"根本测不出来
   * （第一版用 300KB = 10 片，把上限调成 64 照样绿 —— 10 个在途本来就没到 16）。
   */
  const payload = Buffer.from(Array.from({ length: 700 * 1024 }, (_, i) => (i * 31) % 251))
  const SLICES = Math.ceil(payload.length / (32 * 1024))

  it('读：乱序完成后逐字节正确', async () => {
    const mem = asyncMem(payload)
    const got = await readRemoteFile(mem.sftp, '/big.bin', 1024 * 1024)
    expect(got.length).toBe(payload.length)
    expect(got.equals(payload)).toBe(true)
    expect(mem.closes).toBe(1)
    /*
     * 往返次数也要钉住 —— 这是整片改动的**唯一目的**。
     * 22 片 + 1 次探 EOF 的尾巴读 = 23；给 2 次余量。
     * 改坏什么会红：并发段被摘掉（退回逐块顺序读，那要 22 个串行往返）。
     * 光断言"内容对"是不够的：顺序实现的内容也是对的，只是慢了 20 倍。
     */
    expect(mem.reads).toBeLessThanOrEqual(SLICES + 3)
  })

  /**
   * SFTP 允许返回少于请求的字节数。每片自己循环补齐，补不齐才算 EOF。
   *
   * ⚠️ 只断言"内容对"是空转的：不补齐的实现照样内容对 —— 因为并发段后面那截顺序读会把
   * 剩下的全捡回来，只是**退化成串行**（这正是整片改动要消灭的东西）。
   * 所以判据必须是往返次数：补齐时每片 2 次读（22 片 = 44）；不补齐时并发段那 22 次全白费，
   * 之后还要串行读完整个文件，总数会翻上去。
   */
  it('读：短读（每次只给一半）在片内补齐，不退化成串行', async () => {
    const mem = asyncMem(payload, payload.length, { shortRead: true })
    const got = await readRemoteFile(mem.sftp, '/big.bin', 1024 * 1024)
    expect(got.equals(payload)).toBe(true)
    // 每片 32KB / 每次 8KB = 4 次读，22 片 = 88；给 3 次余量
    expect(mem.reads).toBeLessThanOrEqual(SLICES * 4 + 3)
  })

  /**
   * stat 报得比实际大（文件在 stat 与 open 之间被截短）。
   * 必须只返回**连续**的那一段 —— 拼进 EOF 之后的东西会产出一个中间有空洞的文件。
   */
  it('读：stat 报大了（文件变短）只返回连续前缀，不留空洞', async () => {
    const actual = payload.subarray(0, 100 * 1024)
    const mem = asyncMem(actual, payload.length)
    const got = await readRemoteFile(mem.sftp, '/shrunk.bin', 1024 * 1024)
    expect(got.length).toBe(actual.length)
    expect(got.equals(actual)).toBe(true)
  })

  /** stat 报 0（/proc 伪文件）→ 并发段跳过，全靠后面那截顺序读兜底 */
  it('读：stat 报 0 时靠顺序尾巴读完，内容仍然完整', async () => {
    const small = payload.subarray(0, 70 * 1024)
    const mem = asyncMem(small, 0)
    const got = await readRemoteFile(mem.sftp, '/proc/fake', 1024 * 1024)
    expect(got.equals(small)).toBe(true)
  })

  it('读：stat 报小了（文件变长）也能读到真 EOF', async () => {
    const mem = asyncMem(payload, 40 * 1024)
    const got = await readRemoteFile(mem.sftp, '/grew.bin', 1024 * 1024)
    expect(got.equals(payload)).toBe(true)
  })

  /**
   * 并发读**加上文件正在被追加写**，是"连续性判定"唯一能被观察到的场景，
   * 也是它真正要防的事：日志文件一边被 append、一边被我们读。
   *
   * 构造：前 6 次读只看得见 96KB，之后的读看得见全部 700KB。于是靠前的片短读到 EOF，
   * 而靠后的片却读到了真数据 —— 少了那句"遇到不完整片就停"，拼出来的东西中间会有一个洞
   * （而且洞后面还接着本该在别处的字节，比缺一段更糟）。
   */
  it('读：并发中途文件变长时，只返回连续前缀（绝不产出中间有洞的内容）', async () => {
    const short = payload.subarray(0, 96 * 1024)
    let seen = 0
    const mem = asyncMem(payload, payload.length, {
      contentAt: () => (seen++ < 6 ? short : payload)
    })
    const got = await readRemoteFile(mem.sftp, '/growing.log', 4 * 1024 * 1024)
    // 允许两种正确结果：只拿到前缀，或者（尾巴那截顺序读补上后）拿到完整内容。
    // 唯一不许出现的是"长度对不上任何一个真实快照"或"字节与 payload 的同位置不符"
    expect(got.length).toBeLessThanOrEqual(payload.length)
    expect(got.equals(payload.subarray(0, got.length))).toBe(true)
  })

  it('读：stat 撒谎时上限仍然兜得住', async () => {
    const mem = asyncMem(payload, 0)
    await expect(readRemoteFile(mem.sftp, '/proc/huge', 8 * 1024)).rejects.toThrow(/太大/)
    expect(mem.closes).toBe(1)
  })

  it('写：乱序完成后按 offset 重组等于原文', async () => {
    const mem = asyncMem(Buffer.alloc(0))
    await writeRemoteFile(mem.sftp, '/tmp/big.bin', payload, 0o644)
    expect(mem.assembled().equals(payload)).toBe(true)
    expect(mem.closes).toBe(1)
  })

  /** 中途失败必须 reject，而且句柄一定要归还 —— 否则远端留一个开着的句柄 */
  it('写：中途失败会 reject，且句柄照样关掉', async () => {
    const mem = asyncMem(Buffer.alloc(0), 0, { failWriteAt: 64 * 1024 })
    await expect(writeRemoteFile(mem.sftp, '/tmp/x', payload, 0o644)).rejects.toThrow(/Permission/)
    expect(mem.closes).toBe(1)
  })

  /**
   * 并发上限必须真的封顶。这条钉的是一个具体决定：编辑走的是 `browseSftpSession()`，
   * 那条通道同时承担文件列表的 readdir/stat —— 塞满 64 个请求会让用户点目录时卡一下。
   * 改坏什么会红：把 IO_CONCURRENCY 调大、或者退回"一次全发出去"。
   */
  it('在途请求数不超过 16（不跟文件列表抢那条通道）', async () => {
    const mem = asyncMem(payload)
    await readRemoteFile(mem.sftp, '/big.bin', 1024 * 1024)
    expect(mem.maxInFlight).toBeGreaterThan(1) // 真的并发了
    expect(mem.maxInFlight).toBeLessThanOrEqual(16)

    const w = asyncMem(Buffer.alloc(0))
    await writeRemoteFile(w.sftp, '/tmp/big.bin', payload, 0o644)
    expect(w.maxInFlight).toBeGreaterThan(1)
    expect(w.maxInFlight).toBeLessThanOrEqual(16)
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
