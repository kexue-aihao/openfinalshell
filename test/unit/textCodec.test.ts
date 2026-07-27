import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import {
  decodeRemoteText,
  detectEol,
  encodeFidelity,
  encodeRemoteText,
  expandEol,
  normalizeCharset,
  normalizeEol,
  type RemoteCharset
} from '../../src/main/sftp/textCodec'

/**
 * 这一层是整条编辑链路里**最容易静默毁文件**的一段：编码猜错、BOM 掉了、行尾被翻面，
 * 三者都不报错，只让用户几天后发现配置文件坏了。所以主力用例是一张
 * 「字节 → 解码 → 编码 → 字节」的往返表，判据是**逐字节相等**。
 */

const gbk = (s: string): Buffer => iconv.encode(s, 'gbk')
const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

describe('往返：解码再编码必须逐字节回到原样', () => {
  /** [说明, 原始字节, 编码] —— 每一行都是一种真实会遇到的文件 */
  const CASES: Array<[string, Buffer, RemoteCharset]> = [
    ['空文件', Buffer.alloc(0), 'utf8'],
    ['纯 ASCII 无换行', utf8('listen 80;'), 'utf8'],
    ['LF 结尾', utf8('a\nb\n'), 'utf8'],
    ['CRLF 结尾', utf8('a\r\nb\r\n'), 'utf8'],
    ['最后一行没有换行', utf8('a\nb'), 'utf8'],
    ['连续空行', utf8('a\n\n\nb\n'), 'utf8'],
    ['UTF-8 中文', utf8('# 中文注释\nserver_name 例子.com;\n'), 'utf8'],
    ['UTF-8 带 BOM', Buffer.concat([BOM, utf8('@echo off\r\n')]), 'utf8'],
    ['UTF-8 emoji（代理对）', utf8('# 日志-🔥\nlevel=debug\n'), 'utf8'],
    ['GBK 中文', gbk('# 中文注释\nserver_name 例子.com;\n'), 'gbk'],
    ['GBK 里含 0x5C 尾字节的字', gbk('中文路径\n'), 'gbk'],
    ['latin1 高位字节', Buffer.from([0x61, 0xe9, 0x0a]), 'latin1'],
    ['制表符与全角空格', utf8('a\t　b\n'), 'utf8'],
    ['只有换行', utf8('\n'), 'utf8']
  ]

  it.each(CASES)('%s', (_label, bytes, charset) => {
    const d = decodeRemoteText(bytes, charset)
    expect(d.lossless).toBe(true)
    expect(d.mixedEol).toBe(false)
    const back = encodeRemoteText(d.text, charset, { eol: d.eol, hasBom: d.hasBom })
    expect(back.equals(bytes)).toBe(true)
  })
})

describe('混用行尾：往返做不到逐字节相等，而这必须被报出来', () => {
  /**
   * 编辑器内部只见 LF、回写按单一 `eol` 还原 —— 对混用行尾的文件，**保存必然把行尾统一掉**。
   * 这不是 bug，是"编辑器不逐行记原始行尾"这个决定的固有代价（见 DecodeResult.mixedEol）。
   * 但它是一次用户没要求的全文件改动，所以必须让调用方看得见、在保存前说一句。
   *
   * 第一版把这两行放进了上面那张往返表里 —— 它们必然红。红得对：往返表的判据是逐字节相等，
   * 而混用行尾的文件在这个设计下不可能满足它。
   */
  it.each([
    ['CRLF 过半', 'a\r\nb\r\nc\n', 'crlf', 'a\r\nb\r\nc\r\n'],
    ['LF 过半', 'a\r\nb\nc\n', 'lf', 'a\nb\nc\n']
  ])('%s：mixedEol 为真，保存后行尾被统一成 %s', (_l, src, eol, expected) => {
    const d = decodeRemoteText(utf8(src), 'utf8')
    expect(d.mixedEol).toBe(true)
    expect(d.eol).toBe(eol)
    const back = encodeRemoteText(d.text, 'utf8', { eol: d.eol, hasBom: d.hasBom })
    expect(back.toString('utf8')).toBe(expected)
    // 逐字节相等做不到 —— 这一行是把"做不到"钉成事实，防止有人以为它应该相等
    expect(back.equals(utf8(src))).toBe(false)
  })

  it('纯 LF 与纯 CRLF 都不算混用', () => {
    expect(decodeRemoteText(utf8('a\nb\n'), 'utf8').mixedEol).toBe(false)
    expect(decodeRemoteText(utf8('a\r\nb\r\n'), 'utf8').mixedEol).toBe(false)
    expect(decodeRemoteText(Buffer.alloc(0), 'utf8').mixedEol).toBe(false)
  })
})

describe('BOM', () => {
  /**
   * BOM 必须"剥掉 + 记住 + 回写时贴回去"。剥了不记 = 替用户删了 BOM
   * （带 BOM 的 .bat/.ps1 行为会变）；不剥 = 编辑器里多一个看不见的 U+FEFF，
   * 会参与查找替换、还会被用户不小心删掉。
   */
  it('识别、剥掉、且不出现在文本里', () => {
    const d = decodeRemoteText(Buffer.concat([BOM, utf8('hi\n')]), 'utf8')
    expect(d.hasBom).toBe(true)
    expect(d.text).toBe('hi\n')
    expect(d.text.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('没有 BOM 就不要凭空造一个', () => {
    const d = decodeRemoteText(utf8('hi\n'), 'utf8')
    expect(d.hasBom).toBe(false)
    expect(encodeRemoteText('hi\n', 'utf8', { eol: 'lf', hasBom: false })).toEqual(utf8('hi\n'))
  })

  /**
   * BOM 的识别必须只在 utf8 下发生。顺带这一条也量出了一个有用的事实：
   * EF BB BF 在 GBK 里**不是**合法序列（EFBB 是一个字，剩下的 BF 是个没有后继的前导字节），
   * 所以这种文件会被判成 lossless=false → 只读。方向是对的。
   */
  it('非 utf8 编码下那三个字节不当 BOM（而且 GBK 解不动它，判为只读）', () => {
    const d = decodeRemoteText(Buffer.concat([BOM, gbk('中\n')]), 'gbk')
    expect(d.hasBom).toBe(false)
    expect(d.lossless).toBe(false)
  })

  it('用户显式要求带 BOM 时贴上去', () => {
    expect(encodeRemoteText('hi', 'utf8', { eol: 'lf', hasBom: true })).toEqual(
      Buffer.concat([BOM, utf8('hi')])
    )
  })
})

describe('lossless：编码对不上时必须报出来', () => {
  /**
   * 这条是本模块存在的**首要理由**。声称是 GBK 但其实不是的文件，iconv 会用替换字符顶上，
   * 一旦回写就把那些字节永久毁掉。调用方看到 lossless=false 应该只给只读。
   */
  /**
   * ⚠️ 这一条是本模块**能力的边界**，写下来是为了不让人误以为 lossless 能判"编码猜对了"。
   *
   * `utf8('中文')` 的字节 E4 B8 AD E6 96 87 按 GBK 解是三个**合法**的 GBK 字
   * （E4B8 / ADE6 / 9687），编码回去逐字节相同 —— 所以 lossless 为真，
   * 而用户看到的是一屏乱码。
   *
   * 这个取舍是刻意的：**乱码用户看得见、切一下编码就好；字节被改写用户看不见。**
   * 所以这个标志只守后者。想判"编码猜没猜对"是另一件事（启发式嗅探），不在这一层。
   */
  it('声称 GBK 实际是 UTF-8 的中文：乱码但 lossless 仍为真（它不判编码对不对）', () => {
    const d = decodeRemoteText(utf8('中文\n'), 'gbk')
    expect(d.lossless).toBe(true)
    expect(d.text).not.toContain('中文') // 确实是乱码
    // 而且回写不会改变任何字节 —— 这正是 lossless 承诺的那一件事
    expect(encodeRemoteText(d.text, 'gbk', { eol: d.eol, hasBom: false }).equals(utf8('中文\n'))).toBe(
      true
    )
  })

  it('GBK 里夹非法字节序列 → lossless=false', () => {
    const d = decodeRemoteText(Buffer.from([0x61, 0x81, 0x20, 0x0a]), 'gbk')
    expect(d.lossless).toBe(false)
  })

  it('声称 UTF-8 实际是 GBK → lossless=false', () => {
    expect(decodeRemoteText(gbk('中文\n'), 'utf8').lossless).toBe(false)
  })

  /** 判据是"往返比字节"而不是"有没有 U+FFFD"：替换字符本身可能是文件里真有的内容 */
  it('文件里真的含 U+FFFD 时不误报', () => {
    const d = decodeRemoteText(utf8('a�b\n'), 'utf8')
    expect(d.lossless).toBe(true)
  })

  it('ASCII 在任何编码下都无损', () => {
    for (const cs of ['utf8', 'gbk', 'big5', 'latin1'] as RemoteCharset[]) {
      expect(decodeRemoteText(utf8('listen 80;\n'), cs).lossless, cs).toBe(true)
    }
  })
})

/**
 * `encodeFidelity` 与上面的 `lossless` 是**两个不同的问题**，都会静默丢数据：
 *  - `lossless` 的输入是**文件**：我读进来的字节能不能原样写回去（用户从未看见的字节）；
 *  - `encodeFidelity` 的输入是**键盘**：用户现在打的字能不能存下去。
 * iconv 对表示不了的字符不报错，悄悄换成 `?` —— 于是"在 GBK 配置里粘一个 emoji"
 * 这条路上，用户看到的是保存成功，文件里躺着的是一个问号，而且再也回不去。
 */
describe('encodeFidelity：用户打的字存不下去时必须拦住', () => {
  it('纯 ASCII 在任何编码下都存得下', () => {
    for (const cs of ['utf8', 'gbk', 'big5', 'latin1'] as RemoteCharset[]) {
      expect(encodeFidelity('listen 80;\n', cs), cs).toEqual({ ok: true })
    }
  })

  it('中文存进 GBK 没问题', () => {
    expect(encodeFidelity('监听端口 = 443\n', 'gbk')).toEqual({ ok: true })
  })

  it('emoji 存进 GBK → 拦住，并点名那个字符', () => {
    const r = encodeFidelity('端口 443 🎉\n', 'gbk')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.chars).toEqual(['🎉'])
    expect(r.distinct).toBe(1)
  })

  /**
   * 一个 emoji 是 1 个码位、2 个 UTF-16 码元，被替换后两个字符串的长度会错开。
   * 按下标比对两个字符串的实现在这条上会把 emoji 之后的**全部内容**报成"不同"——
   * 2MB 的文件里报出"三千个字符无法表示"，而其实只有一个。所以逐个码位试。
   */
  it('emoji 后面还有很多字时，只报那一个（不是从错位处开始全报）', () => {
    const r = encodeFidelity(`🎉${'中'.repeat(500)}`, 'gbk')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.distinct).toBe(1)
    expect(r.chars).toEqual(['🎉'])
  })

  it('多种存不下的字符去重后按首次出现顺序列出', () => {
    const r = encodeFidelity('a🎉b✂c🎉d😀\n', 'gbk')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.distinct).toBe(3)
    expect(r.chars).toEqual(['🎉', '✂', '😀'])
  })

  it('清单有上限，总数照实报（文案里列全部没意义）', () => {
    // 12 个各不相同的 emoji
    const text = Array.from({ length: 12 }, (_, i) => String.fromCodePoint(0x1f600 + i)).join('')
    const r = encodeFidelity(text, 'gbk')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.distinct).toBe(12)
    expect(r.chars).toHaveLength(8)
  })

  it('文件里真的含问号时不误报（判据不是"有没有 ?"）', () => {
    expect(encodeFidelity('what? 真的吗？\n', 'gbk')).toEqual({ ok: true })
  })

  it('latin1 存不下中文', () => {
    const r = encodeFidelity('监听\n', 'latin1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.chars).toEqual(['监', '听'])
  })

  /** utf8 能表示任何合法字符，但**孤立代理**不是合法字符（坏粘贴会带进来） */
  it('utf8 也不是万能的：孤立代理要被拦住', () => {
    expect(encodeFidelity('a\uD800b', 'utf8').ok).toBe(false)
    expect(encodeFidelity('a😀b', 'utf8')).toEqual({ ok: true })
  })

  it('空文本没问题（新建文件的第一次保存）', () => {
    expect(encodeFidelity('', 'gbk')).toEqual({ ok: true })
  })

  it('行尾不参与判定（\\r 与 \\n 在白名单里每种编码都是 ASCII）', () => {
    expect(encodeFidelity('a\r\nb\n', 'big5')).toEqual({ ok: true })
  })
})

describe('detectEol', () => {
  /**
   * 判据是"CRLF 占全部 LF 过半"，不是"出现过 CRLF"。
   * 按"出现过"判会把一个 LF 脚本（里面夹了一段 CRLF 的许可证头）判成 CRLF，
   * 于是保存时把整个文件翻面 —— 那正是事故本身。
   */
  it.each([
    ['空文件 → lf', '', 'lf'],
    ['无换行 → lf', 'abc', 'lf'],
    ['纯 LF', 'a\nb\n', 'lf'],
    ['纯 CRLF', 'a\r\nb\r\n', 'crlf'],
    ['CRLF 过半', 'a\r\nb\r\nc\n', 'crlf'],
    ['LF 过半', 'a\r\nb\nc\n', 'lf'],
    ['刚好一半 → lf（不够过半）', 'a\r\nb\n', 'lf'],
    ['LF 脚本里夹一段 CRLF 头', '# c\r\n# c\r\n' + 'x\n'.repeat(20), 'lf']
  ])('%s', (_label, text, expected) => {
    expect(detectEol(Buffer.from(text, 'utf8'))).toBe(expected)
    expect(detectEol(text)).toBe(expected)
  })
})

describe('normalizeEol / expandEol 必须成对', () => {
  it('归一成 LF', () => {
    expect(normalizeEol('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('还原成 CRLF', () => {
    expect(expandEol('a\nb\n', 'crlf')).toBe('a\r\nb\r\n')
    expect(expandEol('a\nb\n', 'lf')).toBe('a\nb\n')
  })

  /** 还原不许产出 \r\r\n —— 文本进来时已经是纯 LF 了，再遇到 \r 说明上游漏了归一 */
  it('对已经是 LF 的文本反复还原不会叠出 \\r', () => {
    expect(expandEol(expandEol('a\n', 'lf'), 'crlf')).toBe('a\r\n')
  })

  it('孤立的 \\r（老 Mac 行尾）也归一，否则行号会对不上', () => {
    expect(normalizeEol('a\rb')).toBe('a\nb')
  })
})

describe('normalizeCharset：白名单是安全边界，不是便利', () => {
  it.each([
    ['utf-8', 'utf8'],
    ['UTF-8', 'utf8'],
    ['gb2312', 'gbk'],
    ['GBK', 'gbk'],
    ['cp936', 'gbk'],
    ['gb18030', 'gb18030'],
    ['Big5', 'big5'],
    ['iso-8859-1', 'latin1'],
    ['  utf8  ', 'utf8']
  ])('%s → %s', (input, expected) => {
    expect(normalizeCharset(input)).toBe(expected)
  })

  /**
   * ⚠️ 这一组是**安全断言**，不是"暂不支持"。iconv-lite 除了真编码之外还接受
   * hex / base64 / binary 这类字节变换 —— 编码名在内置编辑器里是渲染进程可控输入
   * （状态栏可以切编码），放行 'hex' 就等于让渲染进程用一串 "0a1b2c…" 精确构造任意字节
   * 写到远端文件里，"只传字符串所以构造不出任意字节"这个论证会当场失效。
   */
  it.each(['hex', 'base64', 'binary', 'utf16le', 'ucs2', 'utf-16', 'iso-2022-jp', '', 'nonsense'])(
    '拒绝 %s',
    (input) => {
      expect(normalizeCharset(input)).toBe(null)
    }
  )

  it('iconv 认得但我们不认的必须真的存在（否则这组断言是空转）', () => {
    // 先证明 iconv 确实接受它们 —— 不然"我们拒绝"就没有意义
    for (const cs of ['hex', 'base64', 'binary', 'utf16le']) {
      expect(iconv.encodingExists(cs), cs).toBe(true)
    }
  })

  /** 而且 'hex' 真的能构造任意字节 —— 这条把上面那组的动机钉成事实 */
  it('hex 真的能把任意字节写出来（所以必须拒）', () => {
    expect(iconv.encode('00ff41', 'hex')).toEqual(Buffer.from([0x00, 0xff, 0x41]))
  })
})
