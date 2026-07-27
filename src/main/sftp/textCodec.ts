import iconv from 'iconv-lite'
import { REMOTE_CHARSETS, type RemoteCharset } from '@shared/constants'

/**
 * 远端文本文件的编解码与行尾归一。**纯函数，不碰 SSH 也不碰文件系统。**
 *
 * 内置编辑器要把远端文件的字节变成渲染进程里的字符串、再变回字节。这一层就是那个转换，
 * 而它是整条链路里**最容易静默毁文件**的一段：编码猜错、BOM 掉了、行尾被翻面，
 * 三者都不会报错，只会让用户在几天后发现配置文件坏了。所以这里的每条判定都要能在单测里
 * 对着字节数组钉死，而且**宁可拒绝也不猜**。
 */

/**
 * 编码白名单本身在 `@shared/constants` 的 `REMOTE_CHARSETS`（连"为什么是安全边界"
 * 那段说明一起）—— IPC 边界的 zod 校验与渲染进程的下拉框也得认同一张表，
 * 三处各写一份迟早会漂出一个只有某一处认的编码名。
 */
export type { RemoteCharset }

/**
 * 别名归一：用户/界面可能传 'utf-8'、'GB2312' 这类写法。
 *
 * 白名单里每个名字自己映到自己那一批由 REMOTE_CHARSETS 机械生成，不手写 ——
 * 手写的话，往 shared 那张表里加一个编码却忘了在这儿加 identity 项，
 * 结果是"白名单允许、normalizeCharset 却返回 null"，报错还长得像用户输错了。
 */
const CHARSET_ALIASES: Record<string, RemoteCharset> = {
  ...(Object.fromEntries(REMOTE_CHARSETS.map((c) => [c, c])) as Record<string, RemoteCharset>),
  'utf-8': 'utf8',
  'gb-18030': 'gb18030',
  gb2312: 'gbk', // GB2312 是 GBK 的子集，用 GBK 解不会丢字
  cp936: 'gbk',
  cp950: 'big5',
  'iso-8859-1': 'latin1'
}

export function normalizeCharset(input: string): RemoteCharset | null {
  return CHARSET_ALIASES[input.trim().toLowerCase()] ?? null
}

/** UTF-8 BOM。它必须被单独拿出来处理，见 decodeRemoteText 的说明 */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export type Eol = 'lf' | 'crlf'

export interface DecodeResult {
  /** 行尾已归一成 LF 的文本（编辑器内部只见 LF，见 normalizeEol） */
  text: string
  /** 原文件的行尾，回写时要还原成它 */
  eol: Eol
  /** 原文件带 UTF-8 BOM。回写时要贴回去，否则等于替用户删了它 */
  hasBom: boolean
  /**
   * 原文件**混用**了 LF 与 CRLF。
   *
   * 这一位必须存在，因为编辑器内部只见 LF、回写时按 `eol` 统一还原 —— 对混用行尾的文件，
   * 这意味着**保存会把整个文件的行尾统一掉**，而且往返不可能逐字节相等。
   * 那正是 editGuards.detectEolRegression 一直在警告的那类改动，所以调用方必须能看见它、
   * 在保存前告诉用户一句。（不做"保留混用"的方案：那要求编辑器逐行记住原始行尾，
   * 而 CodeMirror 的文档模型按行存、行分隔符是它自己的事，硬要保留就得在每次编辑后
   * 重新对账每一行，代价与收益完全不成比例。）
   */
  mixedEol: boolean
  /**
   * 这份字节能不能无损地经"解码 → 编码"回到原样。
   *
   * ⚠️ 它回答的是**"回写会不会改变字节"**，**不是**"编码猜对了没有"。这两件事不同，
   * 而混淆它们会得出一个错误的安全感：`utf8('中文')` 的字节 E4 B8 AD E6 96 87
   * 按 GBK 解是三个**合法**的 GBK 字（E4B8 / ADE6 / 9687），编码回去逐字节相同 ——
   * 于是 lossless 为真，而用户看到的是一屏乱码。
   *
   * 这个取舍是刻意的：**乱码用户看得见、切一下编码就好；字节被改写用户看不见。**
   * 所以这个标志只守后者。false 的来源是**非法字节序列**（声称 GBK 但夹了孤立的
   * 前导字节、或其实是 UTF-8 而恰好凑不成合法 GBK），这时 iconv 会用替换字符顶上，
   * 回写就会永久毁掉那些字节 —— 调用方看到 false 应该只给只读。
   */
  lossless: boolean
}

/**
 * 字节 → 文本。
 *
 * BOM 为什么要单独处理：iconv-lite 解 'utf8' 时会把 BOM 留在字符串开头变成
 * U+FEFF，那个字符会显示成一个诡异的空白、参与查找替换、还会被用户不小心删掉；
 * 而如果我们自己剥掉却不记住它，回写时 BOM 就没了 —— 对某些 Windows 侧工具
 * （以及带 BOM 的 .bat/.ps1）那是行为改变。所以剥掉 + 记住 + 回写时贴回去。
 *
 * `lossless` 为什么用"编码回去比字节"而不是查有没有替换字符：替换字符（U+FFFD）
 * 本身可能是文件里真有的内容，按它判会误报；而往返比较是精确的。
 */
export function decodeRemoteText(buf: Buffer, charset: RemoteCharset): DecodeResult {
  const hasBom = charset === 'utf8' && buf.subarray(0, 3).equals(UTF8_BOM)
  const body = hasBom ? buf.subarray(3) : buf

  const raw = iconv.decode(body, charset)
  const lossless = iconv.encode(raw, charset).equals(body)
  const counts = countEol(body)

  return {
    text: normalizeEol(raw),
    eol: counts.lf === 0 ? 'lf' : counts.crlf * 2 > counts.lf ? 'crlf' : 'lf',
    hasBom,
    mixedEol: counts.crlf > 0 && counts.crlf < counts.lf,
    lossless
  }
}

/**
 * 文本 → 字节。`eol` 与 `hasBom` 应当原样来自 decodeRemoteText，
 * 除非用户在状态栏上显式改过（那是他的选择，不是我们猜的）。
 *
 * 顺序：先还原行尾、再编码、最后贴 BOM。
 *
 * 诚实地说一句：对**当前白名单里的这几种编码**，反过来（先编码再往字节流里插 \r）
 * 其实也不会出错 —— GBK/Big5 的尾字节范围都是 0x40 以上，0x0A 不可能是某个字的后半截，
 * 所以在它前面插一个 0x0D 切不坏任何字符。我试过把顺序倒过来，单测**照样全绿**。
 * 保留这个顺序不是因为它现在挡住了什么，而是因为它零成本、且白名单一旦长出
 * 尾字节能取到 0x0A 的编码就仍然正确。别把它当成一道有牙的防线。
 */
export function encodeRemoteText(
  text: string,
  charset: RemoteCharset,
  opts: { eol: Eol; hasBom: boolean }
): Buffer {
  const body = iconv.encode(expandEol(text, opts.eol), charset)
  return opts.hasBom && charset === 'utf8' ? Buffer.concat([UTF8_BOM, body]) : body
}

/**
 * 这段文本能不能用这个编码**完整**表示出来。
 *
 * 保存前必须问一次，因为 iconv 对表示不了的字符**不报错**：它悄悄换成 `?`（0x3f）。
 * 于是"在 GBK 的配置文件里粘一个 emoji 然后保存"这条路上，用户看到的是保存成功，
 * 文件里躺着的是一个问号 —— 而这件事再也回不去了。
 *
 * 与 DecodeResult.lossless 是**两个不同的问题**，都得问：
 *  - `lossless` 问的是"我读进来的字节能不能原样写回去"（用户从未看见的字节会不会被毁）；
 *  - 这个函数问的是"用户现在打的字能不能存下去"。
 * 前者的输入是文件，后者的输入是键盘，两边都会静默丢数据。
 *
 * 判据用"编码再解码回来比字符串"而不是查有没有 `?`：文件里本来就可能有真的问号。
 * 行尾不参与（\r 与 \n 在白名单里每种编码都是 ASCII），所以直接对原文判。
 *
 * 找出**哪些**字符不行时按码位逐个试，不按下标比对两个字符串：一个字符可能被换成
 * 多个 `?`，那时两边长度就错开了，按下标比会从错位处开始把后面全报成"不同"
 * （2MB 的文件里报出"三千个字符无法表示"，而其实只有一个 emoji）。逐个试是精确的，
 * 而且只对**去重后**的字符做，代价与文件长度无关。
 * （白名单里这几种编码都是无状态、面向字节的，逐字符与整串编码等价；
 *   哪天加进 ISO-2022 这类带切换状态的编码，这个前提就不成立了。）
 *
 * 遍历用 `for...of`（按码位）而不是下标，否则 emoji 会被切成半个代理对、
 * 报错文案里显示成一个乱码方块 —— 那正好是最需要说清楚的那种字符。
 */
export function encodeFidelity(
  text: string,
  charset: RemoteCharset
): { ok: true } | { ok: false; chars: string[]; distinct: number } {
  // 快路：绝大多数保存都在这里返回，整串一次往返
  if (iconv.decode(iconv.encode(text, charset), charset) === text) return { ok: true }

  const bad: string[] = []
  const seen = new Set<string>()
  for (const ch of text) {
    if (seen.has(ch)) continue
    seen.add(ch)
    if (iconv.decode(iconv.encode(ch, charset), charset) !== ch) bad.push(ch)
  }
  /**
   * 兜底：整串往返对不上、逐字符却一个都挑不出来。目前想不出这种情形，
   * 但"存不下去"这个结论已经是确定的了 —— 宁可给不出字符清单，也绝不报成 ok。
   */
  if (bad.length === 0) return { ok: false, chars: [], distinct: 0 }
  // 文案里列全部没有意义，前几个就够定位了；总数另给
  return { ok: false, chars: bad.slice(0, 8), distinct: bad.length }
}

/**
 * 判定文件用的是哪种行尾。
 *
 * 判据是"CRLF 占全部 LF 的比例过半"，不是"有没有出现过 CRLF"：真实文件常常混行尾
 * （LF 脚本里夹一段 CRLF 的许可证头），按"出现过"判会把一个 LF 文件判成 CRLF，
 * 于是保存时把整个文件翻面 —— 那正是 editGuards.detectEolRegression 在防的事故。
 *
 * 没有换行（单行文件、空文件）时给 'lf'：这是 Linux 远端文件的正确默认，
 * 而且此时"还原行尾"是个空操作，选哪个都不改变字节。
 */
export function detectEol(buf: Buffer | string): Eol {
  const { lf, crlf } = countEol(typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf)
  if (lf === 0) return 'lf'
  return crlf * 2 > lf ? 'crlf' : 'lf'
}

/**
 * lf 是 \n 的总数（含 CRLF 里的那个），crlf 是其中前面跟着 \r 的个数，
 * 于是 crlf/lf 就是 CRLF 占比 —— 比分别数两种行尾再互减少一次出错机会。
 * （editGuards.countEol 是同一套算法。没有合并成一处：那边吃的是"存盘前后两个 buffer"、
 *   服务于行尾回归告警，这边吃的是"刚读回来的文件"、服务于回写还原；
 *   合并会让两边被迫共享一个签名，而它们哪天各自演化时耦合的代价大于这十行重复。）
 */
function countEol(b: Buffer): { lf: number; crlf: number } {
  let lf = 0
  let crlf = 0
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== 0x0a) continue
    lf++
    if (i > 0 && b[i - 1] === 0x0d) crlf++
  }
  return { lf, crlf }
}

/**
 * 行尾归一成 LF，供编辑器内部使用。
 *
 * 为什么编辑器内部只见 LF：CodeMirror 的文档模型按行存，行分隔符是它自己的事；
 * 让编辑器同时面对 CRLF 会让"光标列号""选区长度""查找替换"全都要考虑那个不可见的 \r。
 * 代价是回写前必须还原 —— 那正是 expandEol，两个函数必须成对使用。
 *
 * 孤立的 \r（老 Mac 行尾）也归一成 \n：它在今天的 Linux 配置文件里出现就是个错误，
 * 而留着它会让行号在编辑器与远端之间对不上。
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** LF → 目标行尾。与 normalizeEol 成对使用 */
export function expandEol(text: string, eol: Eol): string {
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}
