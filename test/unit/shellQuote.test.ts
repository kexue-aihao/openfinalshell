import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { shQuote, UnsafeArgError, wrapShellScript } from '../../src/main/ssh/shellQuote'
import { findSh, shFile } from '../posixSh'

/**
 * 这个文件是"往服务器上发 shell 命令"这条链路的地基测试，所以刻意用**三层互相校验**的写法，
 * 而不是一张精确字符串表了事 —— 一张表最危险的失效方式是"我手算的期望值和实现错得一模一样"：
 *
 *  ① 精确字符串表：钉住常见形状，任何改动都会红。
 *  ② 独立的反引号解析器（shUnquote）：按 POSIX 规范**另写一遍**，断言
 *     shUnquote(shQuote(x)) === x，且顺带断言"没有任何字节漏在引号外"（那正是注入本身）。
 *     它是照规范写的、不是抄实现的，所以能抓住 ① 抓不住的"两边一起错"。
 *  ③ 真 shell 往返：本机有 POSIX sh 就把 wrapShellScript 的产物真的跑一遍。
 *     它同时验证了 ② 那个 oracle 自己是对的。
 */

// ---------------------------------------------------------------------------
// ② oracle：一个独立写的 POSIX 单引号解析器
// ---------------------------------------------------------------------------

/**
 * 把一个"词"按 POSIX shell 的引号规则还原成字面值。
 *
 * 只认两件事：`'…'`（内部一切原样）和 `\x`（转义下一个字符）。**引号外出现任何裸字符就抛** ——
 * 对 shQuote 的输出来说那是不可能发生的（它整体被引号包着），一旦发生就意味着有字节漏在了
 * 引号外，而那就是命令注入。所以这个"过于严格"是刻意的。
 */
function shUnquote(word: string): string {
  let out = ''
  let i = 0
  while (i < word.length) {
    const ch = word[i]
    if (ch === "'") {
      const end = word.indexOf("'", i + 1)
      if (end < 0) throw new Error(`单引号未闭合：${JSON.stringify(word)}`)
      out += word.slice(i + 1, end)
      i = end + 1
    } else if (ch === '\\') {
      if (i + 1 >= word.length) throw new Error(`反斜杠悬空：${JSON.stringify(word)}`)
      out += word[i + 1]
      i += 2
    } else {
      throw new Error(`引号外漏出裸字符 ${JSON.stringify(ch)}：${JSON.stringify(word)}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// ① 精确字符串表
// ---------------------------------------------------------------------------

/** [说明, 输入, shQuote 的精确输出] */
const CASES: Array<[string, string, string]> = [
  ['空串', '', "''"],
  ['普通字母', 'a', "'a'"],
  ['绝对路径', '/data/foo', "'/data/foo'"],
  ['含单引号', "it's", "'it'\\''s'"],
  ['只有一个单引号', "'", "''\\'''"],
  ['两个连续单引号', "''", "''\\'''\\'''"],
  ['路径里含单引号', "/data/it's/x", "'/data/it'\\''s/x'"],
  // 反斜杠必须**原样保留** —— 拿双引号思维写这个函数（顺手把 \ 也转义）是经典 bug
  ['反斜杠', 'a\\b', "'a\\b'"],
  ['Windows 风格路径', 'C:\\Windows\\system32', "'C:\\Windows\\system32'"],
  ['反斜杠紧跟单引号', "a\\'b", "'a\\'\\''b'"],
  ['命令替换', '$(id)', "'$(id)'"],
  ['反引号', '`id`', "'`id`'"],
  ['变量', '$HOME', "'$HOME'"],
  ['花括号变量', '${HOME}', "'${HOME}'"],
  ['通配星号', '*', "'*'"],
  ['通配组合', 'a*b?c[d]', "'a*b?c[d]'"],
  // 因此**永远不能依赖 ~ 展开**：它是字面量，不是家目录
  ['波浪号', '~', "'~'"],
  ['波浪号路径', '~/x', "'~/x'"],
  ['空格', 'a b', "'a b'"],
  ['分号拼命令', 'a;rm -rf /', "'a;rm -rf /'"],
  ['管道与重定向', 'a|b&&c>d<e', "'a|b&&c>d<e'"],
  // 引得住，但依然是个"选项"—— 所以构造器必须另外放 `--`
  ['像选项的字符串', '-rf', "'-rf'"],
  ['双横线', '--', "'--'"],
  // 单引号里的换行是**合法字面量**，在这一层拒掉是错的
  ['换行', 'a\nb', "'a\nb'"],
  ['制表符', 'a\tb', "'a\tb'"],
  ['井号', '#comment', "'#comment'"],
  ['叹号', '!x', "'!x'"],
  ['双引号', 'a"b', "'a\"b'"],
  ['中文与空格', '中文 名.txt', "'中文 名.txt'"],
  ['emoji', '日志-🔥.log', "'日志-🔥.log'"]
]

describe('shQuote', () => {
  it.each(CASES)('%s', (_label, input, expected) => {
    expect(shQuote(input)).toBe(expected)
  })

  it('每一行都能被独立的解析器还原，且没有字节漏在引号外', () => {
    for (const [label, input] of CASES) {
      expect(shUnquote(shQuote(input)), label).toBe(input)
    }
  })

  it('含换行的输入不抛（协议约束归 assertSafeRemotePath，不归这里）', () => {
    expect(() => shQuote('a\nb')).not.toThrow()
    expect(() => shQuote('a\r\nb')).not.toThrow()
  })

  it('NUL 是唯一拒掉的字节（没有任何引法能表达它，静默截断更危险）', () => {
    expect(() => shQuote('/data/x\0/../../etc')).toThrow(UnsafeArgError)
    expect(() => shQuote('\0')).toThrow(/NUL/)
  })

  /**
   * 三层嵌套锁死 wrapShellScript 那条 `sh -c` 包法：谁"简化"了那层包装，这条就红。
   * 期望值不手写字面量 —— 手算三层引号正是最容易和实现一起错的地方，
   * 所以用 oracle 逐层剥回来（每剥一层都必须没有裸字符漏出）。
   */
  it('嵌套三层仍能逐层剥回原值', () => {
    const raw = "/data/it's/$(id)/a\\b"
    const l1 = shQuote(raw)
    const l2 = shQuote(l1)
    const l3 = shQuote(l2)
    expect(shUnquote(l3)).toBe(l2)
    expect(shUnquote(shUnquote(l3))).toBe(l1)
    expect(shUnquote(shUnquote(shUnquote(l3)))).toBe(raw)
  })
})

describe('wrapShellScript', () => {
  /** 这一条是手算的、且短到能用眼睛验：脚本里的 ' 到外层变成 '\'' */
  it('精确形状：env 前缀 + sh -c + 整段脚本被引成一个参数', () => {
    expect(wrapShellScript("printf %s 'x'")).toBe(
      "env LC_ALL=C LANG=C sh -c 'printf %s '\\''x'\\'''"
    )
  })

  it('LC_ALL 与 LANG 都要有（本地化过的报错和数字格式会让解析出错）', () => {
    expect(wrapShellScript('true')).toBe("env LC_ALL=C LANG=C sh -c 'true'")
  })

  it('多行脚本整体只是一个参数', () => {
    const wrapped = wrapShellScript('a\nb')
    expect(wrapped).toBe("env LC_ALL=C LANG=C sh -c 'a\nb'")
    // 去掉 `env … sh -c ` 前缀后剩下的那一个词，还原回来必须是原脚本
    expect(shUnquote(wrapped.slice('env LC_ALL=C LANG=C sh -c '.length))).toBe('a\nb')
  })
})

// ---------------------------------------------------------------------------
// ③ 真 shell 往返
// ---------------------------------------------------------------------------

// 找 sh、拼子 shell 的 PATH、"写文件再 sh <文件>"而不是 sh -c 的理由，全在 test/posixSh.ts
const SH = findSh()
const dir = SH ? mkdtempSync(join(tmpdir(), 'ofs-shquote-')) : null

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(SH === null)('真 shell 往返（本机没有 POSIX sh 时跳过）', () => {
  /** 把 wrapShellScript 的产物交给真 shell，取回 printf 打出来的字节 */
  const runThroughShell = (input: string): string => {
    const file = join(dir as string, 'run.sh')
    writeFileSync(file, wrapShellScript(`printf %s ${shQuote(input)}`), 'utf8')
    return shFile(SH as string, file)
  }

  it.each(CASES.filter(([, input]) => !input.includes('\r')))(
    '%s 经过 sh -c 两层解析后逐字节不变',
    (_label, input) => {
      expect(runThroughShell(input)).toBe(input)
    }
  )

  it('注入尝试不会执行：$(…) 与反引号原样打印出来', () => {
    expect(runThroughShell('$(echo pwned)')).toBe('$(echo pwned)')
    expect(runThroughShell('`echo pwned`')).toBe('`echo pwned`')
    expect(runThroughShell("x'; echo pwned; '")).toBe("x'; echo pwned; '")
  })
})
