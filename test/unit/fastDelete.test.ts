import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findSh, shFile, toShellPath } from '../posixSh'
import {
  assertDeletable,
  buildFastDeleteCommand,
  chunkDeletePaths,
  fastDeletePreview,
  parseLeftover
} from '../../src/main/sftp/fastDelete'
import { FAST_DELETE_BATCH } from '../../src/shared/constants'

describe('assertDeletable — 拒绝表', () => {
  /**
   * 深度规则（非空路径段至少两级）一条就干掉了所有系统一级目录，**包括将来才会出现的**。
   * 这张表里 `/etc`、`/root`、`/usr` 那几行不是"黑名单命中"，是深度不够 ——
   * 所以不用维护清单，也不会过时。
   */
  const REJECT: Array<[string, string]> = [
    ['根目录', '/'],
    ['根目录带斜杠', '//'],
    ['根通配', '/*'],
    ['/etc（只有一级）', '/etc'],
    ['/root（只有一级）', '/root'],
    ['/usr（只有一级）', '/usr'],
    ['/tmp（只有一级）', '/tmp'],
    ['/home（只有一级）', '/home'],
    ['一级带尾斜杠', '/etc/'],
    ['空串', ''],
    ['纯空白', '   '],
    ['当前目录', '.'],
    ['父目录', '..'],
    ['波浪号（不会展开，只是个相对名）', '~'],
    ['家目录相对路径', '~/data/x'],
    ['相对路径', 'data/foo'],
    ['像选项的字符串', '-rf'],
    ['爬回上层', '/a/../etc'],
    ['深路径里藏 ..', '/data/app/../../etc'],
    ['结尾是 ..', '/data/app/..'],
    ['含换行', '/data/a\nb'],
    ['含回车', '/data/a\rb'],
    ['含 NUL', '/data/a\0b'],
    ['超长', `/data/${'a'.repeat(5000)}`]
  ]

  it.each(REJECT)('拒绝 %s', (_label, path) => {
    expect(() => assertDeletable(path)).toThrow()
  })

  /** 深度规则拒掉的必须是"层级"这个理由，别被别的检查抢先兜走（否则规则改坏了也看不出来） */
  it('一级目录报的是层级不够，不是别的原因', () => {
    expect(() => assertDeletable('/etc')).toThrow(/层级过浅/)
    expect(() => assertDeletable('/')).toThrow(/层级过浅/)
  })

  const ACCEPT = [
    '/data/foo',
    '/home/deploy',
    '/var/log/nginx',
    "/data/it's",
    '/data/$(id)',
    '/data/`id`',
    '/data/a b/c',
    '/data/中文 名.txt',
    '/data/*.log',
    '/data/-rf',
    '/opt/app/releases/2026-07-26/dist'
  ]

  it.each(ACCEPT)('接受 %s', (path) => {
    expect(assertDeletable(path)).toBe(path)
  })

  /** 通配元字符**刻意不拒**：真实文件名里可以有 `*`，而我们全程单引号包着、它是字面量 */
  it('通配元字符不被拒（拒了用户就删不掉自己的文件）', () => {
    expect(assertDeletable('/data/*')).toBe('/data/*')
    expect(assertDeletable('/data/[a-z]?.log')).toBe('/data/[a-z]?.log')
  })
})

describe('buildFastDeleteCommand', () => {
  it('精确形状：rm -rf -- + 同命令内的残留探测 + (exit) 把状态留给 RC 哨兵', () => {
    expect(buildFastDeleteCommand(['/data/foo', "/data/it's"])).toBe(
      `rm -rf -- '/data/foo' '/data/it'\\''s'
__ofs_rm=$?
for p in '/data/foo' '/data/it'\\''s'; do
  if [ -e "$p" ] || [ -L "$p" ]; then printf 'OFSLEFT:%s\\n' "$p"; fi
done
(exit $__ofs_rm)`
    )
  })

  /**
   * 末尾必须是 `(exit …)` 而不是 `exit …`：ExecRunner 会在脚本后面追加 RC 哨兵，
   * 真 exit 会让哨兵永远不执行、于是每次都拿不到退出码（而 null 一律当"未知"）。
   */
  it('末尾不是裸 exit', () => {
    const cmd = buildFastDeleteCommand(['/data/foo'])
    expect(cmd.endsWith('(exit $__ofs_rm)')).toBe(true)
    expect(cmd).not.toMatch(/\nexit /)
  })

  it('注入尝试全部落在引号里', () => {
    const cmd = buildFastDeleteCommand(['/data/$(touch /tmp/pwned)'])
    expect(cmd).toContain("'/data/$(touch /tmp/pwned)'")
    // 命令替换没有逃出引号（引号外只剩我们自己写的固定词）
    expect(cmd.replace(/'[^']*'/g, '')).not.toContain('$(')
  })

  it('守卫在构造时就跑，非法路径连命令都生成不出来', () => {
    expect(() => buildFastDeleteCommand(['/etc'])).toThrow(/层级过浅/)
    expect(() => buildFastDeleteCommand(['/data/ok', '/'])).toThrow(/层级过浅/)
  })

  it('空数组与超批量都拒', () => {
    expect(() => buildFastDeleteCommand([])).toThrow(/没有要删除/)
    const many = Array.from({ length: FAST_DELETE_BATCH + 1 }, (_, i) => `/data/f${i}`)
    expect(() => buildFastDeleteCommand(many)).toThrow(new RegExp(String(FAST_DELETE_BATCH)))
  })
})

describe('chunkDeletePaths', () => {
  it('少量路径就一批', () => {
    expect(chunkDeletePaths(['/data/a', '/data/b'])).toEqual([['/data/a', '/data/b']])
  })

  it('按条数上限切批', () => {
    const paths = Array.from({ length: FAST_DELETE_BATCH * 2 + 3 }, (_, i) => `/data/f${i}`)
    const batches = chunkDeletePaths(paths)
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(FAST_DELETE_BATCH)
    expect(batches[1]).toHaveLength(FAST_DELETE_BATCH)
    expect(batches[2]).toHaveLength(3)
    // 一条都不能丢
    expect(batches.flat()).toEqual(paths)
  })

  it('按命令长度上限切批（两条 4000 字符的路径塞不进同一条命令）', () => {
    const long = [`/data/${'a'.repeat(4000)}`, `/data/${'b'.repeat(4000)}`]
    const batches = chunkDeletePaths(long)
    expect(batches).toHaveLength(2)
    // 每一批都真的能构造出命令来（不会产出一个必然报"命令过长"的批）
    for (const batch of batches) expect(() => buildFastDeleteCommand(batch)).not.toThrow()
  })

  it('空输入给空数组（由调用方报错，chunk 自己不判业务）', () => {
    expect(chunkDeletePaths([])).toEqual([])
  })
})

describe('parseLeftover', () => {
  it('挑出 OFSLEFT 行', () => {
    expect(parseLeftover("OFSLEFT:/data/a\nOFSLEFT:/data/it's\n")).toEqual([
      '/data/a',
      "/data/it's"
    ])
  })

  it('全删掉时是空数组', () => {
    expect(parseLeftover('')).toEqual([])
    expect(parseLeftover('\n\n')).toEqual([])
  })

  it('不挑出别的行（rm 的报错走 stderr，不在这条流上）', () => {
    expect(parseLeftover("rm: cannot remove '/data/a'\nOFSLEFT:/data/a\n")).toEqual(['/data/a'])
  })

  it('容忍尾部 \\r', () => {
    expect(parseLeftover('OFSLEFT:/data/a\r\n')).toEqual(['/data/a'])
  })
})

describe('fastDeletePreview', () => {
  it('给出第一批的命令原文与总数', () => {
    const p = fastDeletePreview(['/data/a', '/data/b'])
    expect(p.count).toBe(2)
    expect(p.batches).toBe(1)
    expect(p.command).toBe(buildFastDeleteCommand(['/data/a', '/data/b']))
  })

  it('多批时如实报批数（界面要说清"共 N 批"，不能只给第一批就假装是全部）', () => {
    const paths = Array.from({ length: FAST_DELETE_BATCH + 5 }, (_, i) => `/data/f${i}`)
    const p = fastDeletePreview(paths)
    expect(p.count).toBe(paths.length)
    expect(p.batches).toBe(2)
  })

  /** 守卫在**弹框之前**就拒 —— 不能等用户点完"我确认删除"才报错 */
  it('非法路径在预览阶段就抛', () => {
    expect(() => fastDeletePreview(['/etc'])).toThrow(/层级过浅/)
    expect(() => fastDeletePreview([])).toThrow(/没有要删除/)
  })
})

// ---------------------------------------------------------------------------
// 真 shell 跑一遍：命令的**语义**，不只是它的字节
// ---------------------------------------------------------------------------

/**
 * 上面那些用例只能证明"命令长得对"。这一段把生成的命令交给真的 POSIX shell，
 * 对着一棵**敌意命名**的本地目录树跑一遍 —— 于是"引号是不是真的把 $(…) 关住了"
 * 由 shell 自己回答，而不是由我对 shell 的理解回答。
 *
 * 这是计划里那条真机验收「快速删除抗注入」在没有服务器时能做到的最接近的形式。
 * 仍然**不能**替代真机：MSYS 的 rm 与 Linux 的 rm 不是同一个实现，权限语义也不同。
 */
const SH = findSh()
const root = SH ? mkdtempSync(join(tmpdir(), 'ofs-fastdel-')) : null

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(SH === null)('真 shell 跑一遍（本机没有 POSIX sh 时跳过）', () => {
  const runCommand = (command: string): string => {
    const file = join(root as string, 'run.sh')
    writeFileSync(file, command, 'utf8')
    return shFile(SH as string, file, root as string)
  }

  it('删掉一棵敌意命名的树，注入没有发生，树外的哨兵没被碰', () => {
    const base = root as string
    const tree = join(base, 'tree')
    writeFileSync(join(base, 'sentinel.txt'), 'keep me', 'utf8')

    // 名字全部选成 Windows 也合法的（* ? " < > | : 在 NTFS 上非法，所以这里不用）
    const hostile = [
      'a',
      'a/b',
      "it's",
      '-rf',
      '$(touch pwned)',
      '`touch pwned2`',
      '中文 名',
      'has space',
      ';rm -rf x'
    ]
    mkdirSync(tree)
    for (const name of hostile) {
      mkdirSync(join(tree, name), { recursive: true })
      writeFileSync(join(tree, name, 'f.txt'), 'x', 'utf8')
    }

    const stdout = runCommand(buildFastDeleteCommand([toShellPath(tree)]))

    expect(parseLeftover(stdout)).toEqual([])
    expect(existsSync(tree)).toBe(false)
    expect(existsSync(join(base, 'sentinel.txt'))).toBe(true)
    // 命令替换与反引号都只是文件名的一部分，绝不能真的执行
    expect(existsSync(join(base, 'pwned'))).toBe(false)
    expect(existsSync(join(base, 'pwned2'))).toBe(false)
  })

  it('一个目标名里带单引号也删得掉（引号嵌套真的对）', () => {
    const base = root as string
    const target = join(base, "quote'd dir")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'f.txt'), 'x', 'utf8')

    const stdout = runCommand(buildFastDeleteCommand([toShellPath(target)]))
    expect(parseLeftover(stdout)).toEqual([])
    expect(existsSync(target)).toBe(false)
  })

  it('删不存在的路径：rm -rf 退 0 且没有残留（这是"已经没了"，不是失败）', () => {
    const missing = join(root as string, 'never-existed')
    const stdout = runCommand(buildFastDeleteCommand([toShellPath(missing)]))
    expect(parseLeftover(stdout)).toEqual([])
  })

  it('多目标里只删掉存在的那些，残留探测逐条对应', () => {
    const base = root as string
    const a = join(base, 'multi-a')
    const b = join(base, 'multi-b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const stdout = runCommand(
      buildFastDeleteCommand([toShellPath(a), toShellPath(b), toShellPath(join(base, 'multi-c'))])
    )
    expect(parseLeftover(stdout)).toEqual([])
    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(false)
  })

  /** 残留探测得真的会报 —— 没有这条，上面那些"leftover 为空"的断言全是空转 */
  it('删不掉时残留探测报得出来（拿一个还开着句柄的文件当靶子）', () => {
    const base = root as string
    const target = join(base, 'leftover-probe')
    mkdirSync(target, { recursive: true })
    // 不真去造"删不掉"（跨平台不可靠），改成把命令的删除部分换掉、只跑探测那一半：
    // 断言的是 `[ -e ] || [ -L ]` 那段循环确实会 printf 出来
    const command = buildFastDeleteCommand([toShellPath(target)]).replace(
      /^rm -rf -- .*$/m,
      'true'
    )
    const stdout = runCommand(command)
    expect(parseLeftover(stdout)).toEqual([toShellPath(target)])
    expect(existsSync(target)).toBe(true)
  })
})
