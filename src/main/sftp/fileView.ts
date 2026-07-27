import { type RemoteCharset } from '@shared/constants'
import type { RemoteFileView, SessionId } from '@shared/types'
import { toRemotePath } from './remotePath'
import { readRemoteTextFile } from './remoteTextFile'
import { decodeRemoteText } from './textCodec'
import { sshManager } from '../ssh/SshConnectionManager'

/**
 * 内置编辑器的**只读**打开：读字节 → 解码 → 返回。
 *
 * 它刻意是**无状态**的：没有注册表、没有 id、没有本地临时文件、远端不留任何东西。
 * 于是"重试"就是再调一次，"换个编码看看"也是再调一次 —— 不需要任何状态迁移，
 * 也不可能出现"界面以为在看 A、main 侧记着的是 B"。
 * 与 RemoteEditManager 那条有状态的路（8 个态、本地副本、文件监视）区别见
 * shared/types.ts 里 RemoteFileView 的说明。
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
