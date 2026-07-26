import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkTarEntries,
  classifyExtractStderr,
  extractTar,
  findLocalTar,
  listTarEntries,
  tarTimeoutMs
} from '../../src/main/sftp/localTar'

describe('findLocalTar', () => {
  it('给的是绝对路径，且指向一个真实存在的文件', () => {
    const p = findLocalTar()
    // 本机没装 tar 的话返回 null 是正确行为（调用方降级为逐文件）
    if (p === null) return
    expect(isAbsolute(p)).toBe(true)
    expect(existsSync(p)).toBe(true)
  })

  /**
   * 这一条是本文件最重要的断言之一。开发机上 `where tar` 命中的第一个是
   * `C:\Program Files\Git\usr\bin\tar.exe`（MSYS 的 GNU tar 1.35，会做路径改写），
   * 而我们要的是 System32 那个 bsdtar。走 PATH 就会拿错的那一个。
   */
  it('win32 上必须落在 %SystemRoot% 下，绝不能是 Git/MSYS 那一个', () => {
    if (process.platform !== 'win32') return
    const p = findLocalTar()
    if (p === null) return
    const root = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase()
    expect(p.toLowerCase().startsWith(root)).toBe(true)
    expect(p.toLowerCase()).not.toContain('git')
  })
})

describe('checkTarEntries', () => {
  const ok = (names: string[], top = 'app'): ReturnType<typeof checkTarEntries> =>
    checkTarEntries(names, top)

  it('正常的一棵树全部放行', () => {
    expect(ok(['app/', 'app/a.txt', 'app/sub/', 'app/sub/b.txt'])).toEqual({ unsafe: [] })
  })

  it('顶层项自己（带或不带尾斜杠）都算在顶层之下', () => {
    expect(ok(['app'])).toEqual({ unsafe: [] })
    expect(ok(['app/'])).toEqual({ unsafe: [] })
  })

  it('GNU tar 有时给的 ./ 前缀不算越界', () => {
    expect(ok(['./app/', './app/a.txt'])).toEqual({ unsafe: [] })
  })

  /** 空名单必须当越界：0 字节文件的 `tar -tf` **实测退 0 且没有输出** */
  it('空名单当越界处理（否则一次失败的下载会被报成成功）', () => {
    const r = ok([])
    expect(r.unsafe).toHaveLength(1)
    // 断言**拒的理由**：空名单同时也会撞上"顶层项不止一个"（0 个 ≠ 1 个），
    // 只断言"被拒了"的话，删掉这条专门的检查照样是绿的
    expect(r.unsafe[0]).toContain('一个成员都没有')
  })

  it.each([
    ['绝对路径', '/etc/passwd'],
    ['盘符路径', 'C:\\Windows\\x'],
    ['盘符正斜杠', 'C:/Windows/x'],
    ['直接 ..', '../x'],
    ['中间 ..', 'app/../../etc/passwd'],
    ['结尾 ..', 'app/sub/..'],
    ['当前目录段', 'app/./x'],
    // bsdtar 会把 `\` 归一成分隔符（实测），所以穿越检查必须把它一起切开
    ['反斜杠拼的穿越', 'app/..\\..\\evil.txt'],
    ['反斜杠混斜杠拼的穿越', 'app/sub\\../../evil'],
    ['空名', '/']
  ])('拒绝 %s', (_label, name) => {
    const r = ok(['app/', name])
    expect(r.unsafe).toContain(name)
  })

  it.each([
    ['第二个顶层', 'other/x'],
    ['顶层是前缀但不同名', 'application/x'],
    // 名字含换行会被 `tar -tf` 切成两行，两半的第一段互不相同 → 关门，方向正确
    ['被换行切开的后半截', 'evil.sh']
  ])('拒绝 %s（顶层项不止一个）', (_label, name) => {
    const r = ok(['app/', name])
    expect(r.unsafe.join(' ')).toMatch(/顶层项不止一个/)
  })

  /**
   * 顶层名非 ASCII 时**不按名字比**，只按"只能有一个顶层"判。
   * 按名字比会踩编码问题：远端目录叫 `中文` 时 list 吐的是 CP936 字节，
   * 与 JS 里的 UTF-8 字符串怎么都对不上 —— 那样一个中文目录名就让整个功能关门。
   */
  it('非 ASCII 顶层名：只判"唯一顶层"，不做身份核对', () => {
    // 模拟 CP936 字节被 latin1 解出来的样子（与传进去的 UTF-8 名字对不上）
    expect(checkTarEntries(['ÖÐÎÄ/', 'ÖÐÎÄ/a.txt'], '中文')).toEqual({ unsafe: [] })
    // 但"两个顶层"依然拦得住
    expect(checkTarEntries(['ÖÐÎÄ/a.txt', 'other/b'], '中文').unsafe.join(' ')).toMatch(
      /顶层项不止一个/
    )
  })

  it('纯 ASCII 顶层名仍然做身份核对（多一道保险）', () => {
    expect(checkTarEntries(['other/', 'other/a'], 'app').unsafe.join(' ')).toMatch(/期望 app/)
  })

  /**
   * "名字在 Windows 上非法"**刻意不检查**（与计划里写的不一样）。实测 bsdtar 解包时
   * 既不报错也不失败，而是自己就地改名：`app/a:b.txt` → `a_b.txt`（正好与逐文件那条路上
   * sanitizeLocalName 的结果一致），`con` 与 `trailing.` 原样落地，rc=0、stderr 一个字都没有。
   * 所以既没有"白费一次下载"可躲，加了还会因为编码问题必然误判（见下一条）。
   */
  it.each([
    ['保留名', 'app/con'],
    ['冒号', 'app/a:b'],
    ['问号', 'app/a?b'],
    ['尾部点', 'app/report.'],
    ['尾部空格', 'app/report ']
  ])('%s 放行（bsdtar 自己会就地改名，不会失败）', (_label, name) => {
    expect(ok(['app/', name])).toEqual({ unsafe: [] })
  })

  it('合法的中文/emoji/空格名字放行', () => {
    expect(ok(['app/', 'app/中文 名.txt', 'app/日志-🔥.log', 'app/a b/c d.txt'])).toEqual({
      unsafe: []
    })
  })

  /**
   * 名字是 `latin1` 解出来的**字节**，不是可读文本 —— Windows 上 `tar -tf` 按系统 ANSI
   * 代码页输出（本机 CP936）。这一条喂的就是真实测到的 GBK 字节：`日志-火.log` 的
   * GBK 编码里含 0x5C（也就是 `\`），要是当年那版把"含反斜杠"单独判成越界，
   * 一个中文文件名就能让整次打包下载关门。
   */
  it('GBK 字节里夹着的 0x5C 不会被误判成越界', () => {
    // \xD6\xD0\xCE\xC4 = GBK 的"中文"；再塞一个 0x5C 模拟尾字节恰好是反斜杠的名字
    const gbkish = 'app/ÖÐ\ÎÄ.txt'
    expect(ok(['app/', gbkish])).toEqual({ unsafe: [] })
  })
})

describe('classifyExtractStderr', () => {
  it('空 stderr', () => {
    expect(classifyExtractStderr('')).toEqual({ skippedSymlinks: 0, fatal: [] })
  })

  /**
   * Windows 上没有 SeCreateSymbolicLinkPrivilege 时，bsdtar 会为**每条软链**报一行并退非 0，
   * 而其余文件一个不少地解出来了。把非 0 一律当失败，等于"下载任何含软链的目录"都报错。
   */
  it('软链失败是良性的，会计数但不致命', () => {
    const r = classifyExtractStderr(
      [
        "tar.exe: Can't create link 'app/link': Client does not have required privilege",
        "tar.exe: app/link2: Cannot restore symlink",
        'tar.exe: Error exit delayed from previous errors.'
      ].join('\n')
    )
    expect(r.skippedSymlinks).toBe(2)
    expect(r.fatal).toEqual([])
  })

  /** 反过来也要守住：认不出的行一律硬失败，宁可多报一次错 */
  it('认不出的行硬失败（不许把"磁盘满了"当成"跳过了软链"）', () => {
    const r = classifyExtractStderr('tar.exe: app/big.bin: Write error: No space left on device')
    expect(r.fatal).toHaveLength(1)
    expect(r.skippedSymlinks).toBe(0)
  })

  it('良性行与致命行混在一起时，致命的那条不会被吞掉', () => {
    const r = classifyExtractStderr(
      [
        "tar.exe: Can't create link 'app/link': privilege",
        'tar.exe: app/x: Write error: No space left on device'
      ].join('\n')
    )
    expect(r.skippedSymlinks).toBe(1)
    expect(r.fatal).toHaveLength(1)
  })
})

describe('tarTimeoutMs', () => {
  it('小包也给到两分钟底线', () => {
    expect(tarTimeoutMs(0)).toBe(120_000)
    expect(tarTimeoutMs(1024)).toBe(120_000)
  })

  it('大包按 5MB/s 放大（一个永远不返回的子进程比偏松的上限更糟）', () => {
    expect(tarTimeoutMs(5 * 1024 * 1024 * 600)).toBe(600_000)
  })
})

// ---------------------------------------------------------------------------
// 真 tar 往返
// ---------------------------------------------------------------------------

const TAR = findLocalTar()
const root = TAR ? mkdtempSync(join(tmpdir(), 'ofs-localtar-')) : null

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(TAR === null)('真 tar 往返（本机没有 tar 时跳过）', () => {
  const tar = TAR as string

  /** 造一棵包含各种合法但麻烦的名字的树，用同一个 tar 打成归档 */
  const buildArchive = (name: string, top: string): string => {
    const base = join(root as string, name)
    mkdirSync(join(base, top, 'sub'), { recursive: true })
    writeFileSync(join(base, top, 'a.txt'), 'hello\n', 'utf8')
    writeFileSync(join(base, top, 'sub', 'b.bin'), Buffer.from([0, 1, 2, 255]))
    writeFileSync(join(base, top, '中文 名.txt'), '内容\n', 'utf8')
    writeFileSync(join(base, top, "it's.txt"), 'quote\n', 'utf8')
    writeFileSync(join(base, top, '日志-🔥.log'), 'emoji\n', 'utf8')
    writeFileSync(join(base, top, 'empty'), '')
    const archive = join(root as string, `${name}.tar`)
    execFileSync(tar, ['-c', '-f', archive, '-C', base, '--', top])
    return archive
  }

  it('列出成员 → 校验通过 → 解包 → 逐字节相等', async () => {
    const archive = buildArchive('round', 'app')
    const listed = await listTarEntries(tar, archive, 30_000)
    expect(listed.ok).toBe(true)
    expect(listed.names.length).toBeGreaterThan(5)

    // 中文/emoji 的名字在 list 里是 ANSI 代码页的字节（读不懂），但一条都不该被判越界
    const check = checkTarEntries(listed.names, 'app')
    expect(check).toEqual({ unsafe: [] })

    const dest = join(root as string, 'out')
    mkdirSync(dest, { recursive: true })
    const outcome = await extractTar(tar, archive, dest, 30_000)
    expect(outcome.fatal).toEqual([])
    expect(outcome.ok).toBe(true)

    expect(readFileSync(join(dest, 'app', 'a.txt'), 'utf8')).toBe('hello\n')
    expect(readFileSync(join(dest, 'app', 'sub', 'b.bin'))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(readFileSync(join(dest, 'app', '中文 名.txt'), 'utf8')).toBe('内容\n')
    expect(readFileSync(join(dest, 'app', "it's.txt"), 'utf8')).toBe('quote\n')
    expect(readFileSync(join(dest, 'app', '日志-🔥.log'), 'utf8')).toBe('emoji\n')
    expect(readFileSync(join(dest, 'app', 'empty'), 'utf8')).toBe('')
  })

  /** 完整性：**在动用户目录之前**就知道包是坏的 */
  it('截断的归档在列成员这一步就退非 0', async () => {
    const archive = buildArchive('trunc-src', 'app')
    const full = readFileSync(archive)
    const half = join(root as string, 'half.tar')
    writeFileSync(half, full.subarray(0, Math.floor(full.length / 2)))
    const listed = await listTarEntries(tar, half, 30_000)
    expect(listed.ok).toBe(false)
  })

  it('完全不是归档的文件也退非 0', async () => {
    const junk = join(root as string, 'junk.tar')
    writeFileSync(junk, 'this is not a tar archive at all\n', 'utf8')
    expect((await listTarEntries(tar, junk, 30_000)).ok).toBe(false)
  })

  /**
   * 0 字节文件是个陷阱：`tar -tf` 对它**退 0 且没有输出**（实测）。
   * 所以"列成员成功"不足以说明包是好的，空名单必须被 checkTarEntries 拦住。
   */
  it('0 字节归档：列成员居然成功，但空名单被拦住', async () => {
    const empty = join(root as string, 'empty.tar')
    writeFileSync(empty, '')
    const listed = await listTarEntries(tar, empty, 30_000)
    expect(listed.ok).toBe(true)
    expect(listed.names).toEqual([])
    expect(checkTarEntries(listed.names, 'app').unsafe).toHaveLength(1)
  })

  /**
   * 穿越攻击的两道防线一起验。归档是手搓的 ustar（本地建不出这种名字的文件）。
   *
   * 第一道是我们的 checkTarEntries（必须判越界、于是根本不会去解包）；
   * 第二道是 libarchive 自己 —— 实测它把 `\` 归一后报 `Path contains '..'` 并退非 0，
   * evil.txt 哪儿都没落。第二道是"万一第一道被改坏了"的兜底，所以也要有用例盯着，
   * 否则哪天有人放宽了第一道，没人知道还有没有网。
   */
  it('反斜杠拼的穿越：我们判越界，libarchive 也不让它落地', async () => {
    const ustarHeader = (name: string, size: number, typeflag: string): Buffer => {
      const b = Buffer.alloc(512, 0)
      b.write(name, 0, 100, 'utf8')
      b.write('0000644\0', 100, 8, 'ascii')
      b.write('0000000\0', 108, 8, 'ascii')
      b.write('0000000\0', 116, 8, 'ascii')
      b.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
      b.write('00000000000\0', 136, 12, 'ascii')
      b.write('        ', 148, 8, 'ascii')
      b.write(typeflag, 156, 1, 'ascii')
      b.write('ustar\0', 257, 6, 'ascii')
      b.write('00', 263, 2, 'ascii')
      let sum = 0
      for (const byte of b) sum += byte
      b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
      return b
    }
    const body = Buffer.from('PWNED\n', 'utf8')
    const pad = Buffer.alloc(512 - (body.length % 512), 0)
    const archive = join(root as string, 'traversal.tar')
    writeFileSync(
      archive,
      Buffer.concat([
        ustarHeader('app/', 0, '5'),
        ustarHeader('app/ok.txt', body.length, '0'),
        body,
        pad,
        ustarHeader('app/..\\..\\evil.txt', body.length, '0'),
        body,
        pad,
        Buffer.alloc(1024, 0)
      ])
    )

    const listed = await listTarEntries(tar, archive, 30_000)
    expect(listed.ok).toBe(true)
    // 第一道：判越界 → 调用方不会去解包
    expect(checkTarEntries(listed.names, 'app').unsafe).toHaveLength(1)

    // 第二道：真解一次，确认 libarchive 自己也不放它出去
    const deep = join(root as string, 'trav-out', 'a', 'b')
    mkdirSync(deep, { recursive: true })
    const outcome = await extractTar(tar, archive, deep, 30_000)
    expect(outcome.ok).toBe(false)
    expect(outcome.fatal.join(' ')).toMatch(/\.\./)
    expect(existsSync(join(deep, 'app', 'ok.txt'))).toBe(true)
    // 上跳两级、上跳一级、以及目标目录里，都不许出现 evil.txt
    expect(existsSync(join(root as string, 'trav-out', 'evil.txt'))).toBe(false)
    expect(existsSync(join(root as string, 'trav-out', 'a', 'evil.txt'))).toBe(false)
    expect(existsSync(join(deep, 'evil.txt'))).toBe(false)
  })

  /**
   * ⚠️ 这一条在 Windows 上**整条不执行**（NTFS 没有 POSIX mode 可量）。
   * "不许传 -p" 那条在任何平台都跑得到的护栏在 test/renderer/sftpPackWiring.test.ts 里
   * （读源码）——本机全绿**不等于**这一条验过了。
   */
  it('解包不恢复权限（不传 -p）—— 至少不会解出比源更宽的权限', async () => {
    if (process.platform === 'win32') return
    const archive = buildArchive('mode', 'app')
    const dest = join(root as string, 'out-mode')
    mkdirSync(dest, { recursive: true })
    await extractTar(tar, archive, dest, 30_000)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { statSync } = await import('node:fs')
    const mode = statSync(join(dest, 'app', 'a.txt')).mode & 0o777
    expect(mode & 0o002).toBe(0)
  })
})
