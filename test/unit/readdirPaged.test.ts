import type { SFTPWrapper } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { readdirPaged } from '../../src/main/sftp/readdirPaged'
import type { RawDirEntry } from '../../src/main/sftp/entryParse'
import type { RemotePath } from '../../src/main/sftp/remotePath'

/**
 * 目录列举的分页与 symlink 交错。
 *
 * 用一个手写的假 SFTPWrapper 而不是 fixture 服务器，是因为这里要验的恰恰是
 * **请求发出的顺序**（页 k 的 stat 必须在页 k+1 的回包之前就飞出去）与两个
 * 只在特定服务器行为下才出现的边界（某页只剩 `.`/`..` → 空数组；服务器不给 EOF）。
 * fixture 服务器用 fs.readdirSync，永远产不出点目录那一页。
 */

const DIR = '/srv' as RemotePath
/** 记一条操作日志，形如 opendir / readdir#0 / stat:/srv/link1 / close */
type Log = string[]

function raw(name: string, mode: number): RawDirEntry {
  return {
    filename: name,
    longname: `${mode & 0o120000 ? 'l' : '-'}rw-r--r-- 1 root root 0 Jan 1 00:00 ${name}`,
    attrs: { mode, size: 0, mtime: 0, uid: 0, gid: 0 }
  }
}
const FILE = 0o100644
const LINK = 0o120777
const DIRM = 0o040755

interface FakeOpts {
  /** 依次返回的页；每页是一个数组（空数组合法：那一页只剩 . 与 ..） */
  pages: RawDirEntry[][]
  /** 读完 pages 后是否给 EOF；false = 服务器永不给 EOF（死循环防护要接住） */
  eof?: boolean
  /** 这些路径的 stat 报错（断链） */
  statFails?: Set<string>
  /** stat 的目标类型（默认目录） */
  statMode?: number
  /** readdir 第 n 页返回真错误 */
  failPage?: number
}

function fakeSftp(opts: FakeOpts, log: Log): SFTPWrapper {
  let page = 0
  const eofErr = Object.assign(new Error('EOF'), { code: 1 })
  return {
    opendir(_path: string, cb: (err: Error | undefined, handle: Buffer) => void) {
      log.push('opendir')
      setImmediate(() => cb(undefined, Buffer.from('H')))
    },
    readdir(_h: string | Buffer, cb: (err: Error | undefined, list: RawDirEntry[]) => void) {
      const n = page++
      log.push(`readdir#${n}`)
      setImmediate(() => {
        if (opts.failPage === n) return cb(new Error('permission denied'), [])
        if (n < opts.pages.length) return cb(undefined, opts.pages[n])
        if (opts.eof === false) return cb(undefined, []) // 永不 EOF：一直给空页
        cb(eofErr, [])
      })
    },
    stat(path: string, cb: (err: Error | undefined, attrs: { mode: number }) => void) {
      log.push(`stat:${path}`)
      setImmediate(() => {
        if (opts.statFails?.has(path)) return cb(new Error('no such file'), { mode: 0 })
        cb(undefined, { mode: opts.statMode ?? DIRM })
      })
    },
    close(_h: Buffer, cb: (err?: Error) => void) {
      log.push('close')
      setImmediate(() => cb())
    }
  } as unknown as SFTPWrapper
}

describe('readdirPaged：翻页', () => {
  it('多页拼成一个完整列表，最后关句柄', async () => {
    const log: Log = []
    const sftp = fakeSftp(
      { pages: [[raw('a', FILE), raw('b', FILE)], [raw('c', FILE)]] },
      log
    )
    const entries = await readdirPaged(sftp, DIR)
    expect(entries.map((e) => e.name)).toEqual(['a', 'b', 'c'])
    expect(entries.map((e) => e.path)).toEqual(['/srv/a', '/srv/b', '/srv/c'])
    expect(log[0]).toBe('opendir')
    expect(log).toContain('close')
    // 三次 readdir：两页数据 + 一次拿到 EOF
    expect(log.filter((x) => x.startsWith('readdir#'))).toHaveLength(3)
  })

  /**
   * 这一条是本文件最要紧的一条。ssh2 会把 `.` 与 `..` 从每页里剔掉，
   * 于是某一页恰好只有这两项时回来的就是**空数组**。把空数组当 EOF
   * 会静默丢掉后面所有页 —— 用户只会说"这个目录里的东西少了一半"，且不报错。
   */
  it('中间的空页不是 EOF（. 与 .. 被 ssh2 剔掉那一页），后续页必须照读', async () => {
    const log: Log = []
    const sftp = fakeSftp({ pages: [[raw('a', FILE)], [], [raw('z', FILE)]] }, log)
    const entries = await readdirPaged(sftp, DIR)
    expect(entries.map((e) => e.name)).toEqual(['a', 'z'])
  })

  it('服务器不给 EOF 时不死循环，报错并且仍然关句柄', async () => {
    const log: Log = []
    const sftp = fakeSftp({ pages: [[raw('a', FILE)]], eof: false }, log)
    await expect(readdirPaged(sftp, DIR)).rejects.toThrow()
    expect(log).toContain('close')
  })

  it('readdir 真出错时把错误抛出去，并且仍然关句柄', async () => {
    const log: Log = []
    const sftp = fakeSftp({ pages: [[raw('a', FILE)], [raw('b', FILE)]], failPage: 1 }, log)
    await expect(readdirPaged(sftp, DIR)).rejects.toThrow(/permission denied/)
    expect(log).toContain('close')
  })

  it('opendir 失败直接抛（此时还没有句柄可关）', async () => {
    const log: Log = []
    const sftp = {
      opendir(_p: string, cb: (err: Error | undefined, h: Buffer) => void) {
        log.push('opendir')
        setImmediate(() => cb(new Error('no such directory'), Buffer.alloc(0)))
      }
    } as unknown as SFTPWrapper
    await expect(readdirPaged(sftp, DIR)).rejects.toThrow(/no such directory/)
    expect(log).toEqual(['opendir'])
  })
})

describe('readdirPaged：symlink 与翻页交错（本次提速的关键）', () => {
  it('第 1 页的 stat 在第 2 页回包之前就已发出', async () => {
    const log: Log = []
    const sftp = fakeSftp({ pages: [[raw('link1', LINK)], [raw('b', FILE)]] }, log)
    await readdirPaged(sftp, DIR)
    const statAt = log.indexOf('stat:/srv/link1')
    const page2At = log.indexOf('readdir#1')
    expect(statAt).toBeGreaterThan(-1)
    // 交错的证据：stat 排在第二次 readdir **发出**之前 —— 两者同波飞行，
    // 而不是"全部页读完再统一发 stat"（那样 stat 会排在所有 readdir 之后）
    expect(statAt).toBeLessThan(page2At)
  })

  it('每个 symlink 都解析出 targetType，断链记 other', async () => {
    const log: Log = []
    const sftp = fakeSftp(
      {
        pages: [[raw('good', LINK), raw('broken', LINK), raw('plain', FILE)]],
        statFails: new Set(['/srv/broken']),
        statMode: DIRM
      },
      log
    )
    const entries = await readdirPaged(sftp, DIR)
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
    expect(byName.good.type).toBe('symlink')
    expect(byName.good.targetType).toBe('dir')
    expect(byName.broken.targetType).toBe('other')
    // 非 symlink 不该被 stat（多一次往返就是白花的）
    expect(byName.plain.targetType).toBeUndefined()
    expect(log).not.toContain('stat:/srv/plain')
  })

  it('symlink 指向文件时 targetType 是 file（双击行为靠它）', async () => {
    const sftp = fakeSftp({ pages: [[raw('l', LINK)]], statMode: FILE }, [])
    const [entry] = await readdirPaged(sftp, DIR)
    expect(entry.targetType).toBe('file')
  })

  it('所有 symlink 的 stat 都在返回前完成（不许把未解析的条目交出去）', async () => {
    const links = Array.from({ length: 30 }, (_, i) => raw(`l${i}`, LINK))
    const sftp = fakeSftp({ pages: [links.slice(0, 15), links.slice(15)] }, [])
    const entries = await readdirPaged(sftp, DIR)
    expect(entries).toHaveLength(30)
    expect(entries.every((e) => e.targetType === 'dir')).toBe(true)
  })
})
