import type { SFTPWrapper, Stats } from 'ssh2'
import { MAX_EDIT_BYTES } from '@shared/constants'
import { looksBinary } from './editGuards'
import { typeFromMode } from './entryParse'
import { toRemotePath, type RemotePath } from './remotePath'
import { readRemoteFile, sftpLstat, sftpRealpath, sftpStat } from './sftpLowLevel'

/**
 * "把一个远端路径当文本文件读出来"：软链解析 + 三道门（类型 / 尺寸 / 二进制）+ 整文件读。
 *
 * 三道门每一条都是踩出来的，尤其软链那条 —— 见 resolveRemoteTarget 的说明。
 *
 * 提成一处的理由变过一次，值得记一笔：原先是"只读查看"与"外部编辑器的下载-编辑"
 * 两条路要走同一份（后者已删）。现在读只有一个消费者，但**软链解析那一半仍然有两个** ——
 * 读（这里）和写（fileSave），所以它被单独提成了 resolveRemoteTarget。
 *
 * 它**只读**，不产生任何远端副作用。
 */
export interface RemoteTextRead {
  /** 软链解析后的真身。与传入路径相同表示不是软链 */
  resolvedPath: RemotePath
  buf: Buffer
  /** 对**真身**做的 stat（mode / size 都来自它） */
  stat: Stats
}

/**
 * 软链 → 真身。**读和写必须用同一条规则**，所以它是个导出的函数而不是内联几行。
 *
 * 不解析的后果是致命的：写回用的 rename 会把**软链本身**替换成一个普通文件，
 * 而 /etc/nginx/sites-enabled/* 全是软链 —— 用户改一次配置，软链就断了，
 * reload 之后站点直接消失。所以 lstat 判类型、realpath 拿真身，
 * 之后 stat/read/write/rename/chmod 一律对真身做；调用方的 key 仍用原始路径
 * （用户点的是那条）。
 *
 * 只读查看其实不会 rename，但仍然解析：一是 stat 的尺寸/权限要报真身的，
 * 二是这条不变量不该有"某条路可以不遵守"的例外 —— 那种例外迟早会被复制到写的那条路上。
 *
 * lstat 给 null 是"不存在或无权限"（两者不可区分），这里**不下结论**也不报错 ——
 * 原样返回请求路径，让调用方紧接着的 stat 给出统一的报错文案。
 */
export async function resolveRemoteTarget(
  sftp: SFTPWrapper,
  remotePath: RemotePath | string
): Promise<RemotePath> {
  const requested = toRemotePath(remotePath)
  const link = await sftpLstat(sftp, requested)
  return link && typeFromMode(link.mode) === 'symlink'
    ? toRemotePath(await sftpRealpath(sftp, requested))
    : requested
}

export async function readRemoteTextFile(
  sftp: SFTPWrapper,
  remotePath: RemotePath | string
): Promise<RemoteTextRead> {
  const resolvedPath = await resolveRemoteTarget(sftp, remotePath)

  const stat = await sftpStat(sftp, resolvedPath)
  if (!stat) throw new Error(`远端文件不可读（不存在、无权限或断链）：${resolvedPath}`)
  const type = typeFromMode(stat.mode)
  if (type === 'dir') throw new Error(`这是目录，不能作为文本打开：${resolvedPath}`)
  // 设备/管道/socket 读起来会挂住整条 SFTP 通道，宁可在门口拒掉
  if (type !== 'file') throw new Error(`不是普通文件，不能作为文本打开：${resolvedPath}`)
  if (stat.size > MAX_EDIT_BYTES) {
    throw new Error(
      `文件太大，请下载后再打开：${resolvedPath}（${stat.size} 字节，上限 ${MAX_EDIT_BYTES} 字节）`
    )
  }

  const buf = await readRemoteFile(sftp, resolvedPath, MAX_EDIT_BYTES)
  // NUL 字节即拒：这类内容进文本编辑器再存回来，往返一次文件就毁了（UTF-16 也在其中）
  if (looksBinary(buf)) throw new Error(`二进制文件不能用文本编辑器打开：${resolvedPath}`)

  return { resolvedPath, buf, stat }
}
