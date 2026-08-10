import { randomBytes } from 'node:crypto'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { RemoteSaveGates } from '@shared/types'
import { sha256Hex } from './editGuards'
import { remoteBasename, remoteDirname, remoteJoin, type RemotePath } from './remotePath'
import {
  readRemoteFile,
  sftpChmod,
  sftpPosixRename,
  sftpRename,
  sftpStat,
  sftpUnlink,
  writeRemoteFile
} from './sftpLowLevel'
import { t } from '../services/i18n'

/**
 * 把一份文本写回远端。**无状态**：没有注册表、没有 id、没有排队，一次调用要么写成、
 * 要么带着一个明确的理由回来让调用方决定下一步。
 *
 * 这个文件里的每一条判断都是从外部编辑器那条路（已删的 RemoteEditManager）搬过来的 ——
 * 那些是踩出来的，不是想出来的（原子替换、临时文件排他创建、非原子替换的备份顺序、
 * 截断闸门的两条判据）。当时是"搬"而不是"抄"，因为两条路要共用；那条路后来整体删掉了，
 * 但这些判断连同它们的用例一起留了下来（见 test/unit/fileSave.test.ts 末尾那一组）。
 */

/**
 * 冲突检测的分水岭：256KB 以内比内容哈希，以上只比 size+mtime。
 * 不一律比哈希是因为每次保存都把远端整个文件重下一遍只为算个哈希，在 2MB 上就是
 * 一次几百毫秒的白等；而"编辑期间被第三方改动"用 size+mtime 已经能抓住绝大多数
 * （要构造出 size 与 mtime 都不变的改动，得刻意回写同长度内容再 touch 回去）。
 */
export const HASH_COMPARE_MAX_BYTES = 256 * 1024

/**
 * 截断闸门的两条判据（"新内容 0 字节"与"远端 ≥ 4KB 且缩到 1/4 以下"）。
 *
 * 为什么是这两条而不是一个笼统的比例：
 * - **0 字节那一档与文件大小无关**，所以不设尺寸门槛：40 字节的 .env 被清空
 *   和 20KB 的 nginx.conf 被清空一样致命 —— 正在 reload 的服务读到的是空配置。
 * - **比例判据必须配尺寸门槛**：几百字节的 .env / authorized_keys 里删掉一多半
 *   是日常编辑，那个尺度上任何比例都是误报；4KB 往上的配置文件一次保存掉到 1/4 以下，
 *   基本只剩"手滑全选删"一种可能。
 * - 1/4 而不是 1/2：1/2 会把"把一个长配置精简掉一多半"这种真实操作也拦下来。
 *
 * ⚠️ 内置编辑器让这道闸门的**理由变了一半**：它原来主要防的是外部编辑器"分段改写"——
 * 先截断再分几段写回，前半截刚落地就被文件监视读走。内置编辑器的内容直接来自用户的缓冲区，
 * 不存在半截内容。留着它是为了另一半理由：Ctrl+A 之后手滑打了一个字符，
 * 而那一下和"我确实要清空这个文件"在字节上完全一样。
 */
const SHRINK_BASELINE_FLOOR_BYTES = 4 * 1024
const SHRINK_RATIO_DIVISOR = 4

/** 远端临时名/备份名受此约束：绝大多数文件系统单段上限 255 字节 */
const MAX_REMOTE_NAME_BYTES = 255

/**
 * 远端临时名的排他创建尝试次数。撞名只有两种来源：上次崩在写临时文件之后留下的残留、
 * 或者有人在猜名字。换一个新的随机后缀重试比"unlink 掉再用 'w' 建"安全得多 ——
 * 后者等于把 EXCL 挡住的竞态窗口重新开出来，还可能删掉别人的文件。
 */
const REMOTE_TEMP_ATTEMPTS = 3

/** 打开（或上一次保存）那一刻远端的样子。冲突检测拿它比 */
export interface SaveBaseline {
  /** 那份字节的 sha256；超过 HASH_COMPARE_MAX_BYTES 时为 null（改比 size+mtime） */
  sha: string | null
  size: number
  /** stat 打不通时为 null（"未知"）。**绝不用 0 顶替** —— 见 remoteChangedSince */
  mtime: number | null
  mode: number
}

export type SaveOutcome =
  | {
      kind: 'saved'
      bytes: number
      mode: number
      /** 写成之后的新基线，调用方要拿它替换手里那份 */
      baseline: SaveBaseline
      /** 内容已就位但有次要问题（目前只有一种：权限位没能恢复） */
      warning?: string
    }
  /** 远端在这期间变过（或没了）。调用方给用户选"仍然覆盖" */
  | { kind: 'conflict'; reason: string }
  /** 服务器没有 posix-rename。**绝不偷偷退化**，让用户显式决定 */
  | { kind: 'nonAtomic' }
  /** 内容缩得太多，像手滑。remoteBytes/localBytes 供文案用 */
  | { kind: 'shrink'; remoteBytes: number; localBytes: number }

/**
 * 三个"要不要越过这道闸门"的开关。
 *
 * 定义在 `@shared/types` 而不是这里，因为它们是**渲染进程的决定** —— 三个开关各对应
 * 一次"用户看过风险并点了确认"，所以类型该和 IPC 契约摆在一起让评审一眼看见。
 * 「为什么必填、为什么不是一个 force」那段说明在那边。
 */
export type SaveGates = RemoteSaveGates

/**
 * 写回。
 *
 * `gates` 三个字段刻意全部必填、且没有默认值 —— 理由见 RemoteSaveGates。
 */
export async function saveRemoteText(
  sftp: SFTPWrapper,
  target: RemotePath,
  buf: Buffer,
  baseline: SaveBaseline,
  gates: SaveGates
): Promise<SaveOutcome> {
  const stat = await sftpStat(sftp, target)

  if (!gates.overwriteRemoteChanges) {
    // 目标没了（被删/被改名）也算冲突：盲目重建会把用户"我删了这个文件"的动作抹掉
    if (!stat) return { kind: 'conflict', reason: t('err.sftp.saveConflictGone') }
    if (await remoteChangedSince(sftp, target, baseline, stat)) {
      return { kind: 'conflict', reason: t('err.sftp.saveConflictChanged') }
    }
  }

  // 闸门判据拿**远端当前**的长度比，不是本地上一次的：要挡的是"远端那份会不会被一份
  // 半截内容替换掉"。stat 打不通时退回基线里的长度
  const remoteBytes = stat?.size ?? baseline.size
  if (!gates.allowShrink && looksTruncated(remoteBytes, buf.length)) {
    return { kind: 'shrink', remoteBytes, localBytes: buf.length }
  }

  /**
   * 权限保留：mode 取自**刚才那次** stat，不是打开时的快照 —— 编辑期间管理员 chmod 过的话，
   * 用户想要的是"保持现在的权限"。目标不存在时退回基线里的 mode。
   *
   * 说清代价：属主/组/ACL/SELinux 标签**不保留**。原子 rename 换的是 inode，
   * 新 inode 的属主是登录用户、SELinux 标签按目录默认策略重打 ——
   * 这是"绝不让远端文件短暂消失"必须付的价，想保住属主只能牺牲原子性。
   */
  const mode = stat ? stat.mode & 0o7777 : baseline.mode

  /**
   * 原子替换：先写到**同目录**下的隐藏临时名，再 posix-rename 覆盖。
   * 同目录是硬要求 —— 跨文件系统的 rename 一定失败，而 /tmp 与 /etc 常常不在一个挂载点上。
   *
   * 为什么先写临时文件才试 rename：ssh2 判断服务器支不支持 posix-rename 的唯一办法是
   * 真调一次（未通告扩展时它在拼包前同步 throw，一个字节都没上线），而 rename 的源必须
   * 已经存在 —— 否则支持该扩展的服务器会回"no such file"，我们就分不清是"不支持"
   * 还是"源没了"。
   */
  const tmp = await writeRemoteTemp(sftp, target, buf, mode)

  let placed = false
  try {
    placed = await sftpPosixRename(sftp, tmp, target)
  } catch (err) {
    // rename 本身失败（权限、只读挂载）：临时文件不能留在人家目录里
    await sftpUnlink(sftp, tmp).catch(() => {})
    throw err
  }

  if (!placed) {
    if (!gates.allowNonAtomic) {
      /**
       * 服务器不支持原子替换 → 回 nonAtomic，**绝不偷偷退化**。
       * 退化路径必然有一个"目标不存在/不完整"的瞬间，而 `nginx -s reload` 正好在那一瞬间
       * 读到空文件这种事是真会发生的。到这里为止目标文件一个字节都没动，
       * 只是同目录下多了个临时文件 —— 顺手清掉。
       */
      await sftpUnlink(sftp, tmp).catch(() => {})
      return { kind: 'nonAtomic' }
    }
    try {
      await degradedReplace(sftp, tmp, target, stat !== null)
    } catch (err) {
      await sftpUnlink(sftp, tmp).catch(() => {})
      throw err
    }
  }

  /**
   * 写完再显式 chmod 一次：临时文件是新建的，有些服务器会对 open 带的 mode 施加 umask。
   * umask 只会**去掉**权限位（不会加），所以中间不存在"短暂全局可写"的窗口，
   * 这一次只是把被削掉的位补回来。失败不算保存失败 —— 内容已经就位了，
   * 报成失败反而会让用户以为没存上、再存一次。
   */
  let warning: string | undefined
  try {
    await sftpChmod(sftp, target, mode)
  } catch (err) {
    warning = t('err.sftp.saveChmodFailed', {
      detail: err instanceof Error ? err.message : String(err)
    })
  }

  const after = await sftpStat(sftp, target)
  return {
    kind: 'saved',
    bytes: buf.length,
    mode,
    baseline: {
      sha: buf.length <= HASH_COMPARE_MAX_BYTES ? sha256Hex(buf) : null,
      size: after?.size ?? buf.length,
      // stat 打不通时留 null（"未知"），绝不用 0 顶替 —— 见 remoteChangedSince
      mtime: after ? after.mtime : null,
      mode
    },
    warning
  }
}

/**
 * 远端在这期间变过没有。
 *
 * 小文件重读比哈希；大文件只比 size+mtime。
 * mtime 未知（上次写回后那次 stat 没打通）就**只认 size**，不因为"对不上"判冲突：
 * 拿一个假值去比必然不等，那等于把这个文件永久钉在冲突态上 —— 用户只剩"仍然覆盖"
 * 可点，而那是跳过冲突检测的。漏判一次远端改动，比每次都逼他无条件覆盖轻。
 */
export async function remoteChangedSince(
  sftp: SFTPWrapper,
  target: RemotePath,
  baseline: SaveBaseline,
  stat: Stats
): Promise<boolean> {
  if (baseline.sha !== null && stat.size <= HASH_COMPARE_MAX_BYTES) {
    const now = await readRemoteFile(sftp, target, HASH_COMPARE_MAX_BYTES)
    return sha256Hex(now) !== baseline.sha
  }
  if (stat.size !== baseline.size) return true
  if (baseline.mtime === null) return false
  return stat.mtime !== baseline.mtime
}

/**
 * 这次保存像不像"内容被截断了"。判据与理由见 SHRINK_BASELINE_FLOOR_BYTES。
 *
 * 远端为 0 一律放行：空文件本来就没有内容可丢，误拦掉的话"新建文件 → 写内容 → 保存"
 * 这条最常见的路第一次保存就要用户点一次确认。
 */
export function looksTruncated(remoteSize: number, nextSize: number): boolean {
  if (remoteSize === 0) return false
  if (nextSize === 0) return true
  // 乘法而不是除法：整数比较，不必操心 0 除与浮点误差
  return remoteSize >= SHRINK_BASELINE_FLOOR_BYTES && nextSize * SHRINK_RATIO_DIVISOR < remoteSize
}

/**
 * 把内容写到目标同目录下的隐藏临时名，**排他创建**，撞名就换一个新随机名重试。
 *
 * 'wx'（CREAT|EXCL）是安全要求不是洁癖：临时名的格式是公开的、目录常常是别人也能写的
 * （/tmp、/var/www、共享的配置目录），而写入方常常是 root、内容常常是特权文件。
 * 用 'w' 的话，别人只要先在我们即将使用的名字上摆一个符号链接，这次写入就顺着链接
 * 落到他选的路径上去了（open 跟随符号链接，先 stat 再建挡不住竞态）。
 *
 * 撞名一律换名重试，**绝不 unlink 掉再用 'w' 建** —— 那既可能删掉别人的文件，
 * 也把 EXCL 刚挡住的窗口重新开了一遍。
 */
export async function writeRemoteTemp(
  sftp: SFTPWrapper,
  target: string,
  buf: Buffer,
  mode: number
): Promise<string> {
  let last: unknown
  for (let i = 0; i < REMOTE_TEMP_ATTEMPTS; i++) {
    const tmp = siblingTempPath(target, '.ofsedit-')
    try {
      await writeRemoteFile(sftp, tmp, buf, mode, 'wx')
      return tmp
    } catch (err) {
      last = err
    }
  }
  // SFTP v3 没有 EEXIST，服务器对 EXCL 冲突和"目录不可写"一律回 SSH_FX_FAILURE，
  // 底层那句 "Failure" 摆给用户看等于什么都没说
  throw new Error(
    t('err.sftp.saveTempCreateFailed', {
      dir: remoteDirname(target),
      detail: last instanceof Error ? last.message : String(last)
    })
  )
}

/**
 * 同目录下的隐藏随机名。长度受文件系统单段上限约束，必要时截掉主名。
 *
 * 随机数必须用 `randomBytes`，**不能用 Math.random()**：这个名字是上面那条
 * 符号链接抢占防线的另一半 —— EXCL 保证"名字被占了就换一个"，而不可预测保证
 * "别人猜不到我下一个要用哪个名字"。Math.random 的内部状态从几个输出就能反推，
 * 而攻击者需要的只是"在我们创建之前把这个名字摆成一个软链"。
 * （我第一版就写成了 Math.random，是 randomBytes 变成未使用的导入才被发现的。）
 */
export function siblingTempPath(target: string, suffix: string): string {
  const dir = remoteDirname(target)
  const base = remoteBasename(target)
  const tail = `${suffix}${randomBytes(4).toString('hex')}`
  let stem = base
  while (Buffer.byteLength(`.${stem}${tail}`, 'utf8') > MAX_REMOTE_NAME_BYTES && stem.length > 0) {
    stem = stem.slice(0, -1)
  }
  return remoteJoin(dir, `.${stem}${tail}`)
}

/**
 * 用户显式认可后的非原子替换（只在服务器没有 posix-rename 时走到）。
 *
 * 不用"先 unlink 再 rename"：那样一旦在两步之间断线，远端文件就**没了**。
 * 改成"原文件改名备份 → 新内容改名就位 → 删备份"：窗口还是有（两次 rename 之间目标不存在），
 * 但断在窗口里时原内容仍以 .ofsbak- 的名字躺在同目录下，用户还能捞回来；
 * 第二步失败还能把备份改回去，等于把"文件消失"降级成"文件换了个名字"。
 * SFTP 的普通 rename 不覆盖已存在目标，所以备份这一步是必需的，不是保险。
 */
export async function degradedReplace(
  sftp: SFTPWrapper,
  tmp: string,
  target: string,
  targetExists: boolean
): Promise<void> {
  const backup = siblingTempPath(target, '.ofsbak-')
  if (targetExists) await sftpRename(sftp, target, backup)
  try {
    await sftpRename(sftp, tmp, target)
  } catch (err) {
    if (targetExists) await sftpRename(sftp, backup, target).catch(() => {})
    throw err
  }
  if (targetExists) await sftpUnlink(sftp, backup).catch(() => {})
}
