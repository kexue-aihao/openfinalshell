import { createHash } from 'node:crypto'
import { remoteBasename, sanitizeLocalName } from './remotePath'

/**
 * "编辑远端文件" 的判定层：纯函数、不碰 SSH 也不碰文件系统，
 * 好处是这些取舍全都能在单测里对着字节数组钉死，不用起会话。
 */

/**
 * 含 NUL 字节即判为二进制，拒绝进编辑器。
 *
 * 全量扫描，不设嗅探窗口。曾经只看前 8KB，想省一点开销，代价是闸门能被绕过：
 * 前 8KB 纯文本、之后才含 NUL 的文件（带 ASCII 头的 SQLite/PDF、内嵌二进制块的证书打包文件）
 * 会被当文本放进编辑器，存盘时编辑器把那些 NUL 改写掉，而**写回方向用的是同一个判定**，
 * 同一个窗口同样看不见 —— 于是损坏后的内容被原子写回远端，正是这个闸门声称要防的事。
 * 调用方那侧有 2MB 上限（MAX_EDIT_BYTES），对 2MB buffer 做一次 indexOf(0) 是纳秒级的事，
 * 省这点开销换一个可绕过的闸门不值。
 *
 * 顺带这也让 UTF-16 的判定完整了：原先只有前 8KB 里含 ASCII 字符时才认得出来。
 * UTF-16 文本被拒是有意为之，不是漏判（UTF-16 里 ASCII 字符的高字节就是 0x00）：
 * 把 UTF-16 拉下来当普通文本编辑再传回去，编辑器多半按 UTF-8 存盘，
 * 往返一次文件就毁了。宁可让用户走"下载-编辑-上传"。
 */
export function looksBinary(buf: Buffer): boolean {
  return buf.indexOf(0) !== -1
}

/** 目录名取 sha256 前 16 位十六进制：64bit 足够避碰，又不会把 %TEMP% 路径顶到 MAX_PATH */
const DIR_HASH_HEX = 16

/**
 * 临时落地位置：(sessionId, remotePath) → 相对路径片段，调用方再拼 app.getPath('temp')。
 *
 * 两条硬性约束：
 * 1. 确定性 —— 同一个文件重复打开必须复用同一个临时目录，否则用户桌面上会堆一串同名副本；
 * 2. 一编辑一目录 —— 目录里只有这一个文件，localFileWatch 才能靠"监视目录"拿到
 *    编辑器的原子替换（写 tmp 再 rename，直接监视文件会丢事件）。
 * 所以哈希必须把远端路径整条吃进去，只用 basename 会让 /a/x.conf 与 /b/x.conf 撞进同一个目录。
 */
export function tempRelPath(sessionId: string, remotePath: string): { dir: string; file: string } {
  // '\0' 做分隔符：远端路径与 sessionId 都不可能含 NUL，避免 ('a','/b') 和 ('a/','b') 拼成同一串
  const dir = sha256Hex(Buffer.from(`${sessionId}\0${remotePath}`, 'utf8')).slice(0, DIR_HASH_HEX)

  // 保留远端 basename（连扩展名）—— 编辑器全靠扩展名选语法高亮，改名会让 .sh 变成纯文本。
  // sanitizeLocalName 是本仓库处理 Windows 非法名的唯一出口，别在这儿另写一套；
  // 它在非 win32 上原样返回（那些名字在 Linux/macOS 本来合法），落地路径也就是本机路径，无妨。
  const base = remoteBasename(remotePath)
  // 空基名（remotePath 是 '/' 或空串）要在清洗前就兜住：sanitizeLocalName 对空串
  // 在 win32 会吐出 '_'、在别处吐出 ''，两个都不是给人看的名字，统一回退成 'file'
  const cleaned = base === '' ? '' : sanitizeLocalName(base)
  return { dir, file: cleaned === '' ? 'file' : cleaned }
}

/**
 * 阈值不取 0%/100%，因为真实文件本来就常混行尾（LF 脚本里夹一段 CRLF 的许可证头、
 * 结尾多一个孤立 \r\n 之类）。要求"完全纯净"会让记事本这种最该报警的场景反而漏报。
 */
const CRLF_DOMINANT = 0.9
const CRLF_RARE = 0.1

/**
 * 判定存盘是否把行尾整体翻了个面（Win10 记事本会把 LF 全转 CRLF —— 足够毁掉一个 shell 脚本）。
 *
 * 本功能只警告、不改写：替用户改行尾是更大的恶（他也可能真想换行尾），
 * 所以这里只出结论，动不动手交给上层。
 */
export function detectEolRegression(before: Buffer, after: Buffer): 'none' | 'lfToCrlf' | 'crlfToLf' {
  const b = countEol(before)
  const a = countEol(after)
  // 任意一侧没有换行（单行文件、空文件）就无从比较，宁可不报
  if (b.lf === 0 || a.lf === 0) return 'none'

  const beforeCrlfRatio = b.crlf / b.lf
  const afterCrlfRatio = a.crlf / a.lf
  if (beforeCrlfRatio <= CRLF_RARE && afterCrlfRatio >= CRLF_DOMINANT) return 'lfToCrlf'
  if (beforeCrlfRatio >= CRLF_DOMINANT && afterCrlfRatio <= CRLF_RARE) return 'crlfToLf'
  return 'none'
}

/**
 * lf 是 \n 的总数（含 CRLF 里的那个），crlf 是其中前面跟着 \r 的个数，
 * 于是 crlf/lf 就是"CRLF 占比"，比分别数两种行尾再互减少一次出错机会。
 * 孤立的 \r（老 Mac 行尾）不计 —— 这功能只管 LF/CRLF 这一对。
 */
function countEol(buf: Buffer): { lf: number; crlf: number } {
  let lf = 0
  let crlf = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue
    lf++
    if (i > 0 && buf[i - 1] === 0x0d) crlf++
  }
  return { lf, crlf }
}

/**
 * 全项目唯一一份 sha256 十六进制摘要，两类用途都走这里：
 * 1. 本文件 tempRelPath 派生临时目录名（取前 16 位，见 DIR_HASH_HEX）；
 * 2. 上层比对内容有没有实质变化 —— 远端文件是否被别人改过、本地存盘是否只是"点了保存但没动内容"。
 * 别再在别处复制一份：两处实现哪天漂了，第 2 类比对会静默失效（摘要不等就当成有改动，
 * 结果是无谓地写回远端，或者反过来把真实改动当成没改而丢掉）。
 */
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
