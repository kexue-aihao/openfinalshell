import { createHash } from 'node:crypto'

/**
 * 编辑远端文件时的两条内容判定：**纯函数，不碰 SSH 也不碰文件系统。**
 * 好处是这些取舍全都能在单测里对着字节数组钉死，不用起会话。
 *
 * 这个文件原先还有 `tempRelPath`（派生本地临时目录）与 `detectEolRegression`
 * （判存盘有没有把行尾整体翻面），两个都随外部编辑器一起删掉了 ——
 * 它们服务的是"下载到本机 → 外部编辑器存盘 → 比对前后两个 buffer"那条路，
 * 内置编辑器一条都不需要：内容一直在自己手里，行尾是显式带着的（见 textCodec）。
 */

/**
 * 含 NUL 字节即判为二进制，拒绝进编辑器。
 *
 * 全量扫描，不设嗅探窗口。曾经只看前 8KB，想省一点开销，代价是闸门能被绕过：
 * 前 8KB 纯文本、之后才含 NUL 的文件（带 ASCII 头的 SQLite/PDF、内嵌二进制块的证书打包文件）
 * 会被当文本放进编辑器，保存时那些 NUL 被改写掉 —— 正是这个闸门声称要防的事。
 * 调用方那侧有 2MB 上限（MAX_EDIT_BYTES），对 2MB buffer 做一次 indexOf(0) 是纳秒级的事，
 * 省这点开销换一个可绕过的闸门不值。
 *
 * 顺带这也让 UTF-16 的判定完整了：原先只有前 8KB 里含 ASCII 字符时才认得出来。
 * UTF-16 文本被拒是有意为之，不是漏判（UTF-16 里 ASCII 字符的高字节就是 0x00）：
 * 把它拉下来当普通文本编辑再存回去，往返一次文件就毁了。宁可让用户走"下载-编辑-上传"。
 */
export function looksBinary(buf: Buffer): boolean {
  return buf.indexOf(0) !== -1
}

/**
 * 全项目唯一一份 sha256 十六进制摘要。用途只有一类：**比对内容有没有实质变化** ——
 * 远端文件在用户编辑期间是否被别人改过（见 remoteTextWrite 的冲突检测与
 * editBaselines 的基线）。
 *
 * 别再在别处复制一份：两处实现哪天漂了，比对会**静默失效** ——
 * 摘要不等就当成有改动（无谓地判冲突），或者反过来把真实改动当成没改而盖掉别人的东西。
 */
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
