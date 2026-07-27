import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findSh, shCommand, shFile, toShellPath } from '../posixSh'
import { PACK_MIN_FILES } from '../../src/shared/constants'
import {
  buildPackCommand,
  buildProbeScript,
  parsePackOutput,
  parseRemoteProbe,
  shouldPack,
  type PackProbe
} from '../../src/main/sftp/packTransfer'
import { toRemotePath } from '../../src/main/sftp/remotePath'
import { wrapShellScript } from '../../src/main/ssh/shellQuote'

const R = (p: string): ReturnType<typeof toRemotePath> => toRemotePath(p)

// ---------------------------------------------------------------------------
// 远端命令：精确字符串
// ---------------------------------------------------------------------------

describe('buildProbeScript', () => {
  it('精确形状：一条 exec 里把七件事全问回来', () => {
    expect(buildProbeScript(R('/data/app'))).toBe(
      `tar --version 2>&1 | head -n 1 | awk '{print "OFSP:TAR " $0}'
command -v mktemp >/dev/null 2>&1 && echo 'OFSP:MKTEMP yes' || echo 'OFSP:MKTEMP no'
printf 'OFSP:TMPDIR %s\\n' "\${TMPDIR:-/tmp}"
find '/data/app' 2>/dev/null | wc -l | awk '{print "OFSP:COUNT " $1}'
du -sk '/data/app' 2>/dev/null | awk '{print "OFSP:SIZEKB " $1}'
df -Pk "\${TMPDIR:-/tmp}" 2>/dev/null | awk 'NR==2{print "OFSP:FREETMP " $4}'
df -Pk '/data' 2>/dev/null | awk 'NR==2{print "OFSP:FREESRC " $4}'`
    )
  })

  it('目录名里的单引号被正确转义', () => {
    expect(buildProbeScript(R("/data/it's"))).toContain(`find '/data/it'\\''s' 2>/dev/null`)
  })

  /** 两次 df 分开发、各带自己的键 —— 按输出行的位置去对应操作数是"换个发行版就错"的代码 */
  it('两个 df 各有自己的键，不靠输出行的顺序对应', () => {
    const s = buildProbeScript(R('/data/app'))
    expect(s).toContain('OFSP:FREETMP')
    expect(s).toContain('OFSP:FREESRC')
    expect(s.match(/df -Pk/g)).toHaveLength(2)
  })
})

describe('buildPackCommand', () => {
  it('精确形状：mktemp + -C 父目录 + -- 名字 + 退出码分级', () => {
    expect(buildPackCommand(R('/data/app'), R('/tmp'))).toBe(
      `t=$(mktemp '/tmp/ofs-pack.XXXXXXXX') || exit 90
tar -c -f "$t" -C '/data' -- 'app'
rc=$?
if [ $rc -gt 1 ]; then rm -f "$t"; exit 91; fi
printf 'OFSP:PATH %s\\n' "$t"
printf 'OFSP:RC %s\\n' "$rc"`
    )
  })

  /**
   * **GNU tar 退 1 不是失败**：约定是 0 正常 / 1 有差异 / ≥2 致命，
   * 而"file changed as we read it"（树里有活跃日志文件）就是 1。
   * 写成 `|| { rm -f "$t"; exit 91; }` 的话，打包任何含日志的目录都会莫名中止。
   */
  it('只有 rc > 1 才删包报错，rc == 1 照样往下走', () => {
    const cmd = buildPackCommand(R('/data/app'), R('/tmp'))
    expect(cmd).toContain('if [ $rc -gt 1 ]; then rm -f "$t"; exit 91; fi')
    expect(cmd).not.toContain('|| { rm -f')
  })

  it('远端只用 POSIX 交集的短选项（BusyBox 认不全长选项）', () => {
    const cmd = buildPackCommand(R('/data/app'), R('/tmp'))
    expect(cmd).not.toMatch(/--(?!\s|$)/) // 除了操作数分隔的 `--`，不许有长选项
    expect(cmd).not.toContain('-h ')
    expect(cmd).not.toContain('--numeric-owner')
    expect(cmd).not.toContain('-z')
  })

  it('目录名里的单引号与 $() 全在引号里', () => {
    const cmd = buildPackCommand(R("/data/it's/$(id)"), R('/tmp'))
    expect(cmd).toContain(`-C '/data/it'\\''s' -- '$(id)'`)
    /*
     * 用户给的 `$(id)` 必须**恰好出现一次、且两侧紧贴单引号**。
     * 不能用"剥掉引号对之后不含 $("那种写法 —— 这条命令自己就有 `$(mktemp …)`，
     * 剥引号会把它切碎、于是断言变成永远绿的（第一版就是这么错的）。
     */
    const at = cmd.indexOf('$(id)')
    expect(at).toBeGreaterThan(0)
    expect(cmd[at - 1]).toBe("'")
    expect(cmd[at + '$(id)'.length]).toBe("'")
    expect(cmd.indexOf('$(id)', at + 1)).toBe(-1)
  })

  it('tmpBase 是根目录时不会拼出双斜杠', () => {
    expect(buildPackCommand(R('/data/app'), R('/'))).toContain(`mktemp '/ofs-pack.XXXXXXXX'`)
  })
})

describe('parsePackOutput', () => {
  it('取回路径与 tar 的退出码', () => {
    expect(parsePackOutput('OFSP:PATH /tmp/ofs-pack.AbC12345\nOFSP:RC 0\n')).toEqual({
      path: '/tmp/ofs-pack.AbC12345',
      tarRc: 0
    })
  })

  it('缺字段时给 null（宁可报"没回报路径"，不许瞎猜一个）', () => {
    expect(parsePackOutput('')).toEqual({ path: null, tarRc: null })
    expect(parsePackOutput('OFSP:PATH /tmp/x\n').tarRc).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// 探测解析：录下来的真实首行
// ---------------------------------------------------------------------------

describe('parseRemoteProbe：tar 风味', () => {
  const flavorOf = (tarLine: string): string =>
    parseRemoteProbe(`OFSP:TAR ${tarLine}\nOFSP:MKTEMP yes\n`).tarFlavor

  it.each([
    ['GNU tar 1.34', 'tar (GNU tar) 1.34', 'gnu'],
    ['GNU tar 1.26（老 CentOS）', 'tar (GNU tar) 1.26', 'gnu'],
    ['bsdtar', 'bsdtar 3.5.1 - libarchive 3.5.1 zlib/1.2.11 liblzma/5.2.5', 'bsd'],
    ['BusyBox 不认 --version', 'tar: unrecognized option: version', 'busybox'],
    ['BusyBox 自报身份', 'BusyBox v1.35.0 (2022-05-09) multi-call binary.', 'busybox'],
    ['根本没装（dash）', 'sh: 1: tar: not found', 'unknown'],
    ['根本没装（bash）', 'sh: tar: command not found', 'unknown'],
    ['空输出', '', 'unknown']
  ])('%s → %s', (_label, line, expected) => {
    expect(flavorOf(line)).toBe(expected)
  })

  /**
   * toybox 说的是 "Unknown option"，与 BusyBox 的措辞不同 —— 认不出就是 `unknown`，
   * 于是 shouldPack 拒绝打包。方向是安全的（退回逐文件），这条用例是把这个已知缺口写下来，
   * 而不是假装认得。
   */
  it('认不出的 tar（如 toybox）落到 unknown，退回逐文件', () => {
    expect(flavorOf("tar: Unknown option '--version'")).toBe('unknown')
  })
})

describe('parseRemoteProbe：其余字段', () => {
  it('全字段都在', () => {
    const probe = parseRemoteProbe(
      [
        'OFSP:TAR tar (GNU tar) 1.34',
        'OFSP:MKTEMP yes',
        'OFSP:TMPDIR /tmp',
        'OFSP:COUNT 1234',
        'OFSP:SIZEKB 56789',
        'OFSP:FREETMP 10485760',
        'OFSP:FREESRC 20971520'
      ].join('\n')
    )
    expect(probe).toEqual({
      tarFlavor: 'gnu',
      hasMktemp: true,
      tmpDir: '/tmp',
      entryCount: 1234,
      sizeKb: 56789,
      freeTmpKb: 10485760,
      freeSrcKb: 20971520
    })
  })

  it('df 没输出时空间是 null 而不是 0（"探不到"与"没空间"必须分得开）', () => {
    const probe = parseRemoteProbe('OFSP:TAR tar (GNU tar) 1.34\nOFSP:MKTEMP yes\n')
    expect(probe.freeTmpKb).toBe(null)
    expect(probe.freeSrcKb).toBe(null)
    // 数量与体积探不到时按 0 处理（0 会让 shouldPack 因为不够 PACK_MIN_FILES 而拒绝）
    expect(probe.entryCount).toBe(0)
  })

  it('非数字的字段当探不到', () => {
    const probe = parseRemoteProbe('OFSP:COUNT abc\nOFSP:FREETMP -\n')
    expect(probe.entryCount).toBe(0)
    expect(probe.freeTmpKb).toBe(null)
  })

  it('mktemp 缺失', () => {
    expect(parseRemoteProbe('OFSP:MKTEMP no\n').hasMktemp).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shouldPack 判定表
// ---------------------------------------------------------------------------

describe('shouldPack', () => {
  const base: PackProbe = {
    tarFlavor: 'gnu',
    hasMktemp: true,
    tmpDir: '/tmp',
    entryCount: 500,
    sizeKb: 1000,
    freeTmpKb: 10_000_000,
    freeSrcKb: 10_000_000
  }
  const opts = {
    targetExists: false,
    conflictPolicy: 'overwrite',
    remoteDir: R('/data/app'),
    topName: 'app'
  }

  it('一切具备 → 打包，临时文件建在 TMPDIR 下', () => {
    expect(shouldPack(base, opts)).toEqual({ pack: true, tmpBase: '/tmp' })
  })

  it('远端没 tar → 不打包，且原因说得出来', () => {
    const r = shouldPack({ ...base, tarFlavor: 'unknown' }, opts)
    expect(r.pack).toBe(false)
    expect(r.reason).toMatch(/未找到.*tar/)
  })

  it('远端没 mktemp → 不打包（固定名在世界可写的 /tmp 里是软链攻击靶子）', () => {
    expect(shouldPack({ ...base, hasMktemp: false }, opts).pack).toBe(false)
  })

  /** BusyBox 的 tar 下载方向可用（只读远端）；上传方向的限制归 3c，不在这一片 */
  it('BusyBox 的 tar 允许打包下载', () => {
    expect(shouldPack({ ...base, tarFlavor: 'busybox' }, opts).pack).toBe(true)
  })

  it.each([
    [0, false],
    [1, false],
    [PACK_MIN_FILES - 1, false],
    [PACK_MIN_FILES, true],
    [PACK_MIN_FILES + 1, true]
  ])('文件数 %i → 打包 %s', (entryCount, expected) => {
    expect(shouldPack({ ...base, entryCount }, opts).pack).toBe(expected)
  })

  /**
   * 与冲突策略联动。tar 解包天生是覆盖语义，`-k` 会让 GNU tar 每撞一次就退 2、
   * `rename` 根本表达不了 —— 所以目标已存在而用户选的不是"覆盖"时一律不打包。
   */
  it.each([
    ['overwrite', true],
    ['ask', false],
    ['skip', false],
    ['rename', false],
    ['resume', false]
  ])('目标已存在 + 策略 %s → 打包 %s', (conflictPolicy, expected) => {
    expect(shouldPack(base, { ...opts, targetExists: true, conflictPolicy }).pack).toBe(expected)
  })

  it('目标不存在时冲突策略无所谓', () => {
    expect(shouldPack(base, { ...opts, conflictPolicy: 'ask' }).pack).toBe(true)
  })

  /** 打包下载没有 sanitizeLocalName 那一步，顶层名改写不了 —— 需要改写就退回逐文件 */
  it.each([['a:b'], ['con'], ['trailing.']])('顶层名 %s 需要改写 → 不打包', (topName) => {
    if (process.platform !== 'win32') return
    const r = shouldPack(base, { ...opts, topName })
    expect(r.pack).toBe(false)
    expect(r.reason).toMatch(/改写/)
  })

  it('中文顶层名原样通过（sanitizeLocalName 不动它）', () => {
    expect(shouldPack(base, { ...opts, topName: '中文目录' }).pack).toBe(true)
  })

  it('空间不够 → 不打包', () => {
    const tight = { ...base, sizeKb: 1_000_000, freeTmpKb: 1000, freeSrcKb: 1000 }
    const r = shouldPack(tight, opts)
    expect(r.pack).toBe(false)
    expect(r.reason).toMatch(/放不下/)
  })

  it('TMPDIR 不够但源目录所在分区够 → 退到源目录的父目录', () => {
    const r = shouldPack({ ...base, sizeKb: 1_000_000, freeTmpKb: 1000 }, opts)
    expect(r).toEqual({ pack: true, tmpBase: '/data' })
  })

  /** 探不到可用空间时**不打包**：在远端 /tmp 上赌一把的代价是把生产服务器塞满 */
  it('探不到可用空间 → 不打包（不许赌）', () => {
    expect(shouldPack({ ...base, freeTmpKb: null, freeSrcKb: null }, opts).pack).toBe(false)
  })

  it('余量真的留了（刚好等于体积时不够）', () => {
    // 5% + 16MiB 的余量：du -sk 数的是已分配块，稀疏文件/硬链接都会让它偏
    const exact = { ...base, sizeKb: 100_000, freeTmpKb: 100_000, freeSrcKb: 100_000 }
    expect(shouldPack(exact, opts).pack).toBe(false)
  })

  it('远端 TMPDIR 不是绝对路径 → 不打包（它要进 shell 命令）', () => {
    const r = shouldPack({ ...base, tmpDir: 'relative/tmp' }, opts)
    expect(r.pack).toBe(false)
    expect(r.reason).toMatch(/TMPDIR/)
  })
})

// ---------------------------------------------------------------------------
// 真 shell 跑一遍：探测脚本与打包命令的**语义**
// ---------------------------------------------------------------------------

/**
 * 上面那些只能证明"命令长得对"。这一段把生成的脚本交给真 POSIX shell 跑，
 * 于是"引号对不对、mktemp 的模板能不能用、`-C 父目录 -- 名字` 打出来的顶层是不是那一个"
 * 由 shell 和 tar 自己回答。
 *
 * 仍然**不能**替代真机：MSYS 的 GNU tar 与 Linux 的不是同一个构建，`df` 的输出列也可能有别。
 * 但它能抓住"脚本本身写错了"这一整类问题 —— 而那正是没有服务器时最抓不到的。
 */
const SH = findSh()
const root = SH ? mkdtempSync(join(tmpdir(), 'ofs-pack-')) : null

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(SH === null)('真 shell 跑一遍（本机没有 POSIX sh 时跳过）', () => {
  const runScript = (script: string): string => {
    const file = join(root as string, 'run.sh')
    // 与生产完全同一条包法：wrapShellScript 的产物写进文件再 sh <文件>
    // （不能 sh -c <命令串> —— Windows 的参数传递会吃掉反斜杠，见 shellQuote.test.ts）
    writeFileSync(file, wrapShellScript(script), 'utf8')
    return shFile(SH as string, file, root as string)
  }

  /** 造一棵有 N 个文件的树，名字里带单引号和中文 */
  const buildTree = (name: string, files: number): string => {
    const dir = join(root as string, name)
    mkdirSync(join(dir, 'sub'), { recursive: true })
    for (let i = 0; i < files; i++) writeFileSync(join(dir, `f${i}.txt`), `x${i}\n`, 'utf8')
    writeFileSync(join(dir, "it's.txt"), 'quote\n', 'utf8')
    writeFileSync(join(dir, '中文 名.txt'), '内容\n', 'utf8')
    writeFileSync(join(dir, 'sub', 'deep.bin'), Buffer.from([1, 2, 3]))
    return dir
  }

  it('探测脚本的输出真的能被 parseRemoteProbe 解开', () => {
    const dir = buildTree('probe-tree', 12)
    const out = runScript(buildProbeScript(R(toShellPath(dir))))
    const probe = parseRemoteProbe(out)

    // MSYS 自带 GNU tar 1.35
    expect(probe.tarFlavor).toBe('gnu')
    expect(probe.hasMktemp).toBe(true)
    expect(probe.tmpDir.startsWith('/')).toBe(true)
    // 12 个 f*.txt + it's + 中文 + sub/ + sub/deep.bin + 顶层自己
    expect(probe.entryCount).toBeGreaterThanOrEqual(16)
    expect(probe.sizeKb).toBeGreaterThan(0)
    expect(probe.freeTmpKb).not.toBeNull()
    expect(probe.freeSrcKb).not.toBeNull()
  })

  it('目录名带单引号时探测照样跑得通（引号没有逃出去）', () => {
    const dir = buildTree("it's dir", 10)
    const probe = parseRemoteProbe(runScript(buildProbeScript(R(toShellPath(dir)))))
    expect(probe.entryCount).toBeGreaterThanOrEqual(13)
  })

  it('打包命令真的产出一个 tar，顶层恰好是那一个目录', () => {
    const dir = buildTree('pack-tree', 10)
    const shellDir = toShellPath(dir)
    const out = runScript(buildPackCommand(R(shellDir), R(toShellPath(root as string))))
    const { path: tarPath, tarRc } = parsePackOutput(out)

    expect(tarRc).toBe(0)
    expect(tarPath).toMatch(/ofs-pack\.[A-Za-z0-9]{8}$/)
    // mktemp 的模板确实建在我们指定的目录下
    expect(tarPath?.startsWith(toShellPath(root as string))).toBe(true)

    // 列一下成员：顶层必须只有 pack-tree 一个
    const listed = shCommand(SH as string, `tar -tf "${tarPath}"`)
    const tops = new Set(
      listed
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => l.replace(/\r$/, '').split('/')[0])
    )
    expect([...tops]).toEqual(['pack-tree'])
    expect(listed).toContain('pack-tree/sub/deep.bin')
  })

  it('打包一个不存在的目录：rc > 1，临时包被删掉，不留孤儿', () => {
    // 用独占的 tmpBase：与成功那条用例共用目录的话，那边留下的 tar 会被误算成孤儿
    const tmpBase = join(root as string, 'orphan-check')
    mkdirSync(tmpBase, { recursive: true })
    const missing = `${toShellPath(root as string)}/never-existed`
    let failed = false
    try {
      runScript(buildPackCommand(R(missing), R(toShellPath(tmpBase))))
    } catch (err) {
      failed = true
      // tar 对不存在的目录退 2（> 1 = 致命），于是脚本删包并退 91
      expect((err as { status?: number }).status).toBe(91)
    }
    expect(failed).toBe(true)
    const leftovers = shCommand(
      SH as string,
      `ls ${toShellPath(tmpBase)}/ofs-pack.* 2>/dev/null | wc -l`
    )
    expect(leftovers.trim()).toBe('0')
  })
})
