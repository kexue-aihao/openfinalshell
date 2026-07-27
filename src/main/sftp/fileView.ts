import { type RemoteCharset } from '@shared/constants'
import type { RemoteFileView, SessionId } from '@shared/types'
import { rememberBaseline } from './editBaselines'
import { sha256Hex } from './editGuards'
import { toRemotePath } from './remotePath'
import { readRemoteTextFile } from './remoteTextFile'
import { HASH_COMPARE_MAX_BYTES } from './remoteTextWrite'
import { decodeRemoteText } from './textCodec'
import { sshManager } from '../ssh/SshConnectionManager'

/**
 * 内置编辑器的打开：读字节 → 解码 → 返回，顺手把"远端此刻长什么样"记进基线注册表。
 *
 * **幂等**：远端不留任何东西、没有 id、没有本地临时文件，所以"重试"就是再调一次，
 * "换个编码看看"也是再调一次 —— 不需要任何状态迁移，也不可能出现"界面以为在看 A、
 * main 侧记着的是 B"。与 RemoteEditManager 那条（8 个态、本地明文副本、文件监视）
 * 的区别见 shared/types.ts 里 RemoteFileView 的说明。
 *
 * ⚠️ 但它**不再是完全无状态的**（片 2 那会儿是）：保存要回答"远端在你打开它之后
 * 变过没有"，而"你打开它的那一刻"只能被记住。那份记忆放在 editBaselines.ts、
 * 一个字节都不下发给渲染进程，理由写在那个文件顶部。记的是内存里的一条基线，
 * 不是远端副作用 —— 上面那条"幂等"仍然成立（同一路径重复调只是把基线刷成一样的值）。
 *
 * 走浏览连接上那条常驻 SFTP 通道（browseSftpSession），不为看一个文件多拨一条连接 ——
 * 用户点开文件的那一刻，那条通道刚刚为列目录用过，是热的。
 */
export async function viewRemoteFile(
  sessionId: SessionId,
  path: string,
  charset: RemoteCharset = 'utf8'
): Promise<RemoteFileView> {
  const sftp = await sshManager.get(sessionId).browseSftpSession()
  const requestedPath = toRemotePath(path)
  const { resolvedPath, buf, stat } = await readRemoteTextFile(sftp, requestedPath)
  const decoded = decodeRemoteText(buf, charset)

  /**
   * 基线用**刚读到的这份字节**算，不用 stat.size：伪文件、以及读的过程中被追加的文件，
   * 两者会不一样，而冲突检测该比的是"我给用户看的是哪份内容"。
   *
   * 大文件不留哈希（sha 为 null）→ 冲突检测退回 size+mtime，理由见
   * remoteTextWrite.ts 里 HASH_COMPARE_MAX_BYTES 的说明。
   */
  rememberBaseline(sessionId, requestedPath, {
    resolvedPath,
    save: {
      sha: buf.length <= HASH_COMPARE_MAX_BYTES ? sha256Hex(buf) : null,
      size: buf.length,
      mtime: stat.mtime,
      mode: stat.mode & 0o7777
    },
    lossless: decoded.lossless,
    charset
  })

  return {
    requestedPath,
    resolvedPath,
    text: decoded.text,
    charset,
    eol: decoded.eol,
    hasBom: decoded.hasBom,
    mixedEol: decoded.mixedEol,
    lossless: decoded.lossless,
    // 字节数取**实际读到的长度**而不是 stat.size：伪文件、以及读的过程中被追加的文件，
    // 两者会不一样，而界面上那个数应该是"你现在看到的这份有多大"
    bytes: buf.length,
    mode: stat.mode & 0o7777
  }
}
