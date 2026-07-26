import type { OpenMode, SFTPWrapper, Stats } from 'ssh2'
import { toRemotePath, type RemotePath } from './remotePath'

/**
 * ssh2 低阶 SFTP 操作的 Promise 包装。
 *
 * 这批包装原本是 TransferWorker 的私有函数，"编辑远端文件"要用同一批（同样的 EOF 处理、
 * 同样的 open mode 语义），于是上提成共享模块。
 *
 * 依赖面刻意压到最小：只有 ./remotePath + ssh2 类型。特别是**不能** import SftpManager ——
 * 那会成环（sftpLowLevel → SftpManager → sshManager → TransferQueue → TransferWorker → sftpLowLevel），
 * 所以下面宁可重写一份 sftpStat，也不去复用 SftpManager.statSize；几行重复换零依赖是值得的。
 */

/**
 * 单次读/写的块大小。32KB 是 SFTP 的实际甜点：OpenSSH 默认最大包 32768 字节 payload，
 * 再往上服务器要么拆包要么直接拒（ssh2 的 fastGet/fastPut 默认也是这个值）。
 * 与 TransferWorker.CHUNK_SIZE 一致，两条路径的分块行为不会出现"传输能过、编辑不能过"的怪事。
 */
const IO_CHUNK_SIZE = 32 * 1024

// ---------------- 句柄级操作（原 TransferWorker 私有函数，语义未改） ----------------

/**
 * 路径参数一律先过 toRemotePath：这层是所有远端 IO 的收口，
 * 在这里挡住反斜杠比在每个调用点各自记得规范化可靠。
 */
export function sftpOpen(
  sftp: SFTPWrapper,
  path: RemotePath | string,
  flags: OpenMode,
  mode?: number
): Promise<Buffer> {
  const target = toRemotePath(path)
  return new Promise((resolve, reject) => {
    const cb = (err: Error | undefined, handle: Buffer): void =>
      err ? reject(err) : resolve(handle)
    if (mode === undefined) sftp.open(target, flags, cb)
    else sftp.open(target, flags, mode, cb)
  })
}

/** close 的失败没有可行的补救动作（句柄已经不归我们了），所以只 resolve 不 reject */
export function sftpClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    sftp.close(handle, () => resolve())
  })
}

export function sftpWrite(
  sftp: SFTPWrapper,
  handle: Buffer,
  offset: number,
  buf: Buffer
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buf, 0, buf.length, offset, (err) => (err ? reject(err) : resolve()))
  })
}

export function sftpRead(
  sftp: SFTPWrapper,
  handle: Buffer,
  buf: Buffer,
  length: number,
  position: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buf, 0, length, position, (err, bytesRead) => {
      // 读到文件尾 ssh2 给 EOF(code 1) 错误，按 0 字节处理
      if (err) {
        const code = (err as Error & { code?: number }).code
        if (code === 1 || /EOF/i.test(err.message)) return resolve(0)
        return reject(err)
      }
      resolve(bytesRead)
    })
  })
}

// ---------------- 路径级操作 ----------------

/**
 * 属性查询失败（不存在、无权限、断链）统一给 null 而不是抛。
 * 调用方要的判断只有"能不能读到属性"，紧接着的 open/read 会给出比 stat 更准确的报错，
 * 在这里抛只会让每个调用点都套一层 try。
 */
export function sftpStat(sftp: SFTPWrapper, path: RemotePath | string): Promise<Stats | null> {
  const target = toRemotePath(path)
  return new Promise((resolve) => {
    sftp.stat(target, (err, stats) => resolve(err ? null : stats))
  })
}

/** 与 sftpStat 同款容错，区别只是不跟随符号链接（判断"这是个链接吗"用这个） */
export function sftpLstat(sftp: SFTPWrapper, path: RemotePath | string): Promise<Stats | null> {
  const target = toRemotePath(path)
  return new Promise((resolve) => {
    sftp.lstat(target, (err, stats) => resolve(err ? null : stats))
  })
}

/** 这个要抛：解析不出绝对路径时后续操作都没有意义，静默给空串会打到错误目录 */
export function sftpRealpath(sftp: SFTPWrapper, path: RemotePath | string): Promise<string> {
  const target = toRemotePath(path)
  return new Promise((resolve, reject) => {
    sftp.realpath(target, (err, resolved) => (err ? reject(err) : resolve(resolved)))
  })
}

export function sftpChmod(
  sftp: SFTPWrapper,
  path: RemotePath | string,
  mode: number
): Promise<void> {
  const target = toRemotePath(path)
  return new Promise((resolve, reject) => {
    sftp.chmod(target, mode, (err) => (err ? reject(err) : resolve()))
  })
}

/** 注意 SFTP 的 rename 不覆盖已存在目标（要覆盖见 sftpPosixRename，或调用方自己先删） */
export function sftpRename(
  sftp: SFTPWrapper,
  from: RemotePath | string,
  to: RemotePath | string
): Promise<void> {
  const src = toRemotePath(from)
  const dst = toRemotePath(to)
  return new Promise((resolve, reject) => {
    sftp.rename(src, dst, (err) => (err ? reject(err) : resolve()))
  })
}

export function sftpUnlink(sftp: SFTPWrapper, path: RemotePath | string): Promise<void> {
  const target = toRemotePath(path)
  return new Promise((resolve, reject) => {
    sftp.unlink(target, (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * posix-rename@openssh.com：原子替换（目标存在也直接盖掉，中间没有"文件不存在"的瞬间）。
 *
 * 服务器没通告该扩展时，ssh2 在拼包之前就**同步 throw** —— 一个字节都没上线，
 * 所以这个 try/catch 就是一次零开销的能力探测，不发探测包、不产生 RTT。
 * 进了回调才算服务器真支持，回调里的 err（权限、跨设备…）照常 reject。
 *
 * 这里只诚实报告能力：**不**退化成"先删再改名"。那个决定要看调用方愿不愿意承担
 * "删完还没改完就断线 → 原文件没了"的风险，归调用方裁决。
 */
export function sftpPosixRename(
  sftp: SFTPWrapper,
  from: RemotePath | string,
  to: RemotePath | string
): Promise<boolean> {
  const src = toRemotePath(from)
  const dst = toRemotePath(to)
  return new Promise((resolve, reject) => {
    try {
      sftp.ext_openssh_rename(src, dst, (err) => (err ? reject(err) : resolve(true)))
    } catch {
      resolve(false)
    }
  })
}

// ---------------- 整文件读写（编辑远端文件用） ----------------

/**
 * 整文件读入内存，超过 maxBytes 抛错（调用方据此给用户看"文件太大"）。
 *
 * 用 sftpOpen + 循环 sftpRead 而不是 createReadStream：与传输那套保持同一套低层原语，
 * EOF、错误、块大小的行为完全一致，出问题只需要看一个地方。
 * 上限查两次 —— stat 只是快速拒绝，真正兜底的是边读边累计：/proc 之类的伪文件 stat 报 0
 * 却能吐无穷字节，只信 stat 会把主进程读爆。
 */
export async function readRemoteFile(
  sftp: SFTPWrapper,
  path: RemotePath | string,
  maxBytes: number
): Promise<Buffer> {
  const target = toRemotePath(path)
  const stats = await sftpStat(sftp, target)
  if (stats && stats.size > maxBytes) throw tooLarge(target, stats.size, maxBytes)

  const handle = await sftpOpen(sftp, target, 'r')
  try {
    const chunks: Buffer[] = []
    let offset = 0
    for (;;) {
      const buf = Buffer.allocUnsafe(IO_CHUNK_SIZE)
      const read = await sftpRead(sftp, handle, buf, IO_CHUNK_SIZE, offset)
      if (read === 0) break
      chunks.push(buf.subarray(0, read))
      offset += read
      if (offset > maxBytes) throw tooLarge(target, offset, maxBytes)
    }
    return Buffer.concat(chunks)
  } finally {
    await sftpClose(sftp, handle)
  }
}

/**
 * 整文件写到指定路径。
 *
 * mode 在 open 时就带上：不给 mode 的话服务器按 0666 建文件，之后再 chmod 收紧，
 * 中间那一小段窗口里文件是全局可写的。带着 mode 建就没有这个窗口。
 * 反过来，覆盖已存在文件时 mode 不生效（服务器只在创建时用它）—— 正好是编辑保权限想要的。
 *
 * flags 怎么选：
 *   - 'w'（默认，CREAT|TRUNC）：**覆盖一个已知的目标**。跟随符号链接、截断已存在项，
 *     这正是"把内容落到用户点的这个文件上"要的语义。
 *   - 'wx'（CREAT|EXCL）：写**名字可预测、而目录可能被别人写**的文件时必须用它 ——
 *     典型就是目标同目录下的临时文件 `.<name>.ofsedit-<8hex>`。别人先在那个名字上摆一个
 *     符号链接，'w' 就会顺着链接写到他选的路径去，而这里的写入方常常是 root、
 *     内容常常是特权文件。EXCL 的排他性由服务器保证，先 stat 再建挡不住竞态
 *     （同 sftp:touch 的取舍）。
 *
 * 'wx' 撞上已存在项时**直接 reject，绝不退化成 'w' 重试** —— 退化就等于把上面这道门拆了。
 * 代价是报错难看：SFTP v3 没有 EEXIST，OpenSSH 对 EXCL 冲突一律回 SSH_FX_FAILURE，
 * 想给用户人话（或者换个随机名重试）归调用方。
 */
export async function writeRemoteFile(
  sftp: SFTPWrapper,
  path: RemotePath | string,
  data: Buffer,
  mode: number,
  flags: 'w' | 'wx' = 'w'
): Promise<void> {
  const target = toRemotePath(path)
  const handle = await sftpOpen(sftp, target, flags, mode)
  try {
    // 空文件也要走一遍 open/close（'w' 的截断效果就是这么来的），所以循环条件在这里正好跳过
    let offset = 0
    while (offset < data.length) {
      const end = Math.min(offset + IO_CHUNK_SIZE, data.length)
      await sftpWrite(sftp, handle, offset, data.subarray(offset, end))
      offset = end
    }
  } finally {
    await sftpClose(sftp, handle)
  }
}

function tooLarge(path: RemotePath, size: number, maxBytes: number): Error {
  return new Error(`远端文件太大：${path}（${size} 字节，上限 ${maxBytes} 字节）`)
}
