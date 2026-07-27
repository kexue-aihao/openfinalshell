import { readFileSync } from 'node:fs'

/**
 * 源码文本护栏的公用件。
 *
 * 为什么有一整类护栏是**读源码**而不是跑代码：本项目里最贵的几个错都属于"少写一行也编译得过、
 * 跑起来也不抛，只是静默走偏" —— 剥离设置键的那一行被删掉、清场函数没人调、
 * 展示给用户的命令和真正执行的命令不是同一个构造器产出的。类型系统看不见这些，
 * 而对着行为写用例又常常写成"渲染进程 mock 自己跟自己对"的假绿。
 *
 * 这几个小工具原先长在 sftpEditWiring.test.ts 里，第二处要用时提到这儿，
 * 免得两份实现各自漂移（其中 stripComments 那份的坑是踩过的，见下面注释）。
 */

export const read = (rel: string): string => readFileSync(rel, 'utf8')

/**
 * 去掉注释再匹配：护栏要看的是**代码**，不是注释里恰好抄了一遍的那段示例代码。
 * 逐字符扫而不是一条正则替换 —— 字符串/模板串里出现 `//` 或 `/*` 时正则会从那里切一刀，
 * 把后面整段代码当注释吃掉，于是"漏了某个调用"的护栏反倒变成永远绿的。
 */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c
      i++
      while (i < src.length && src[i] !== quote) {
        // 转义对：\' \\ 都要整对吞掉，否则 '\\' 会被当成未闭合的字符串
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        out += src[i]
        i++
      }
      out += quote
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/** 空白全压成一个空格：让断言对 Prettier 的换行/缩进不敏感（那条被删掉的旧护栏就栽在这上面） */
export const flat = (src: string): string => src.replace(/\s+/g, ' ')

/**
 * 取某个块的函数体（含嵌套花括号）。用于"这行调用必须在 close() / before-quit 里面"
 * 这类断言 —— 只在整份文件里搜字符串的话，写在别处（甚至写在一段 dead code 里）也算过。
 */
export function blockAfter(src: string, marker: string): string {
  const at = src.indexOf(marker)
  if (at < 0) throw new Error(`源码里找不到 ${marker}`)
  const open = src.indexOf('{', at)
  if (open < 0) throw new Error(`${marker} 后面没有花括号`)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error(`${marker} 的花括号没闭合`)
}

/**
 * 从契约源码里枚举真实的 channel 名。
 * 三张 map 的 key 全是 `'区段:名字'` 形式的字符串字面量；映射值里的字符串字面量联合
 * （'openFile' | 'saveFile' 之类）不含冒号，天然被这条模式排除在外。
 */
export function channelsOf(map: 'InvokeMap' | 'SendMap' | 'EventMap'): string[] {
  const body = blockAfter(stripComments(read('src/shared/ipc.ts')), `export interface ${map}`)
  return [...body.matchAll(/'([A-Za-z]+:[A-Za-z][A-Za-z0-9-]*)'/g)].map((m) => m[1])
}
