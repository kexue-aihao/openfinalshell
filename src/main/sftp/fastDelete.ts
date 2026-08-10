import {
  FAST_DELETE_BATCH,
  FAST_DELETE_MAX_COMMAND_CHARS,
  FAST_DELETE_TIMEOUT_MS
} from '@shared/constants'
import type { SessionId } from '@shared/types'
import { assertSafeRemotePath, type RemotePath } from './remotePath'
import { execOnce } from '../ssh/ExecRunner'
import { shQuote } from '../ssh/shellQuote'
import { sshManager } from '../ssh/SshConnectionManager'
import { scopedLogger } from '../utils/logger'
import { t } from '../services/i18n'

const log = scopedLogger('fast-delete')

/**
 * 快速删除：直接在服务器上跑 `rm -rf`，而不是逐个 SFTP unlink/rmdir。
 *
 * 为什么值得单独存在：递归删一棵目录树，SFTP 那条路每个条目都要 opendir/readdir/remove
 * 若干个**串行**往返，200ms RTT 上删一万个文件要跑十几分钟；`rm -rf` 是一个往返。
 *
 * 也正因为它是本项目第一次"把用户给的字符串拼进 shell 命令"，这个文件的每一条守卫
 * 都要在**任何字节出门之前**跑完，且守卫本身是纯函数、有精确字符串比对的用例表。
 */

/**
 * 最少路径段数。**这一条规则就是整个安全设计的主体。**
 *
 * 它同时干掉 `/`、`/*`、`/etc`、`/usr`、`/var`、`/home`、`/root`、`/tmp`、`/proc`、`/bin`、
 * `/boot`…… **以及所有将来才会出现的系统一级目录**：没有黑名单要维护、也不会过时。
 * 反过来，任何"危险目录清单"都必然不全 —— 这就是不写清单的理由。
 *
 * 代价说清楚：`/data1` 这种把数据直接挂在一级目录上的用法用不了快速删除，
 * 得走普通递归删除（照旧能用，只是慢）。这条限制**要写进文档，不要事后放宽**。
 */
export const FAST_DELETE_MIN_SEGMENTS = 2

/**
 * 一条路径能不能交给 `rm -rf`。
 *
 * 顺序是先通用守卫（绝对路径、无换行、无 `.`/`..`，见 assertSafeRemotePath）
 * 再深度规则 —— 反过来的话 `/a/../..` 会被算成 3 段而蒙过去。
 *
 * 刻意**不**拒通配元字符：真实文件名里可以有 `*`，而我们全程单引号包着、它是字面量；
 * 而 `/*` 本身只有一段，早就死在深度规则上了。
 * 刻意**不**试图判断"这是不是用户的 $HOME"：main 侧不发一次探测就无从得知，
 * 而真正想护的 `/root`、`/home/xxx` 一个死在深度规则、一个是用户自己的数据目录。
 */
export function assertDeletable(raw: string): RemotePath {
  const p = assertSafeRemotePath(raw, '删除路径')
  const segments = p.split('/').filter(Boolean)
  if (segments.length < FAST_DELETE_MIN_SEGMENTS) {
    throw new Error(
      t('err.sftp.pathTooShallow', {
        min: FAST_DELETE_MIN_SEGMENTS,
        actual: segments.length,
        path: p
      })
    )
  }
  return p
}

/**
 * 生成那条要发出去的命令。**残留探测写在同一条命令里**，于是"哪几条没删掉"是精确的、
 * 且零额外往返 —— 事后逐个 lstat 10 条路径在 200ms RTT 上要两秒。
 *
 * 几个细节：
 *  - `--`：今天其实用不上 —— assertSafeRemotePath 已经强制了前导 `/`，所以操作数不可能
 *    长得像选项。留着是因为它免费，而且哪天有人放宽了"必须绝对路径"这条（比如为了支持
 *    相对于 cwd 的删除），`--` 是那时唯一还站着的那道防线。注意**转义救不了这个**：
 *    `shQuote('-rf')` 得到 `'-rf'`，而 `rm '-rf'` 里它依然是个选项。
 *  - 末尾用 `(exit $__ofs_rm)` 而不是 `exit $__ofs_rm`：ExecRunner 会在脚本后面追加
 *    RC 哨兵，真 `exit` 会让哨兵永远不执行、于是每次都拿不到退出码。子 shell 退出
 *    只是把状态留在 `$?` 里，正好被哨兵读到。
 *  - `printf` 而不是 `echo`：`echo` 对以 `-` 开头或含 `\` 的参数各家实现不一。
 *  - `[ -e ] || [ -L ]`：`-e` 对断掉的软链是假的，而断链也算"还在"。
 */
export function buildFastDeleteCommand(rawPaths: string[]): string {
  if (rawPaths.length === 0) throw new Error(t('err.sftp.noPathsToDelete'))
  if (rawPaths.length > FAST_DELETE_BATCH) {
    throw new Error(t('err.sftp.tooManyPaths', { max: FAST_DELETE_BATCH, actual: rawPaths.length }))
  }
  const list = rawPaths.map((p) => shQuote(assertDeletable(p))).join(' ')
  if (list.length > FAST_DELETE_MAX_COMMAND_CHARS) {
    throw new Error(t('err.sftp.commandTooLong', { chars: list.length }))
  }
  return [
    `rm -rf -- ${list}`,
    '__ofs_rm=$?',
    `for p in ${list}; do`,
    `  if [ -e "$p" ] || [ -L "$p" ]; then printf 'OFSLEFT:%s\\n' "$p"; fi`,
    'done',
    '(exit $__ofs_rm)'
  ].join('\n')
}

/**
 * 按条数与命令长度双重上限切批。纯函数。
 *
 * 单条路径自己就超长是不可能的：assertSafeRemotePath 已经把 4096 字符挡住，
 * 引号后最坏也就 8194 —— 所以这里不会产生"永远塞不进去"的空批死循环。
 * 真出现了（有人改了那两个常量）就让它成为**一条自己一批**，交给 buildFastDeleteCommand 报错。
 */
export function chunkDeletePaths(paths: string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let width = 0
  for (const p of paths) {
    const quotedWidth = shQuote(p).length + 1
    const wouldOverflow =
      current.length >= FAST_DELETE_BATCH || width + quotedWidth > FAST_DELETE_MAX_COMMAND_CHARS
    if (current.length > 0 && wouldOverflow) {
      batches.push(current)
      current = []
      width = 0
    }
    current.push(p)
    width += quotedWidth
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * 从 stdout 里挑出残留行。
 *
 * 不会误抓：`rm -rf` 成功时一个字都不往 stdout 写、失败信息走 stderr，所以这条流上
 * 只有我们自己 printf 的 `OFSLEFT:` 行和 RC 哨兵。而路径里不可能含换行
 * （assertSafeRemotePath 拦掉了）—— 这正是那条规则的用处所在。
 */
export function parseLeftover(stdout: string): string[] {
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    if (line.startsWith('OFSLEFT:')) out.push(line.slice('OFSLEFT:'.length).replace(/\r$/, ''))
  }
  return out
}

export interface FastDeletePreview {
  /** 第一批的命令原文，原样展示给用户（等宽块）。多批时后面几批同形，只是路径不同 */
  command: string
  count: number
  batches: number
}

/**
 * 预览。**纯的、无副作用、不碰会话** —— 所以这条 IPC 不收 sessionId。
 *
 * 用它给确认框填那段命令原文：对一条 `rm -rf` 来说，让用户亲眼看到引号是对的、
 * 路径是他选的那些，是能给的最好的安全感受。而守卫在**弹框之前**就跑完了 ——
 * 非法路径在这里就抛，不会等用户点完"我确认删除"才报错。
 */
export function fastDeletePreview(paths: string[]): FastDeletePreview {
  const batches = chunkDeletePaths(paths)
  if (batches.length === 0) throw new Error(t('err.sftp.noPathsToDelete'))
  return {
    command: buildFastDeleteCommand(batches[0]),
    count: paths.length,
    batches: batches.length
  }
}

export interface FastDeleteResult {
  /** null = 拿不到退出码（通常是中途断连）。**一律当"未知"，永不当成功** */
  exitCode: number | null
  leftover: string[]
  stderr: string
}

/**
 * 真的删。
 *
 * 守卫在这里**重跑一遍**（buildFastDeleteCommand 里就有）—— 绝不假设 preview 一定被调过：
 * 那两条是各自独立的 channel，渲染进程完全可以只调后面这条。
 *
 * 多批时顺序执行、结果聚合。退出码的合并规则是**未知最大**：任何一批拿不到码，
 * 整体就是 null（"我不知道删成没成"比"有一批失败了"更该让用户去核对）。
 */
export async function fastDelete(sessionId: SessionId, paths: string[]): Promise<FastDeleteResult> {
  const conn = sshManager.get(sessionId)
  const batches = chunkDeletePaths(paths)
  if (batches.length === 0) throw new Error(t('err.sftp.noPathsToDelete'))

  const leftover: string[] = []
  let stderr = ''
  let unknown = false
  let failure = 0

  for (const batch of batches) {
    const command = buildFastDeleteCommand(batch)
    const result = await execOnce(conn, command, { timeoutMs: FAST_DELETE_TIMEOUT_MS })
    const batchLeftover = parseLeftover(result.stdout)
    leftover.push(...batchLeftover)
    if (result.stderr) stderr += result.stderr
    if (result.code === null) unknown = true
    else if (result.code !== 0 && failure === 0) failure = result.code
    log.info(
      `rm -rf ${batch.length} path(s) on ${sessionId}: code=${result.code} leftover=${batchLeftover.length}`
    )
  }

  return { exitCode: unknown ? null : failure, leftover, stderr }
}
