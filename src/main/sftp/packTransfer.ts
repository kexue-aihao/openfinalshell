import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import {
  PACK_FREE_MARGIN,
  PACK_FREE_SLACK_KB,
  PACK_MIN_FILES,
  PACK_PROBE_TIMEOUT_MS
} from '@shared/constants'
import type { SessionId, TransferPhase, TransferTask } from '@shared/types'
import { execOnce, type ExecCapable } from '../ssh/ExecRunner'
import { shQuote } from '../ssh/shellQuote'
import { checkTarEntries, extractTar, findLocalTar, listTarEntries, tarTimeoutMs } from './localTar'
import {
  assertSafeRemotePath,
  longPath,
  remoteBasename,
  remoteDirname,
  sanitizeLocalName,
  toRemotePath,
  type RemotePath
} from './remotePath'
import { sftpUnlink } from './sftpLowLevel'
import { statSize } from './SftpManager'
import { runTransfer, TransferAborted, type WorkerHandle } from './TransferWorker'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('pack')

/**
 * 打包下载：远端打一个临时 tarball → 走现有传输队列传这一个文件 → 本地解包。
 *
 * **不做流式 `tar -cf - | `。** 流式唯一的好处是省远端临时空间，代价是
 * `size=-1`（没有百分比/ETA、不能暂停、**不能续传**），而这个功能针对的高延迟链路
 * 同时也是容易断的链路。最要命的一条：**被截断的流和传完的流几乎无法区分**
 * （exit-status 按 SSH 规范可选，TCP 一断就是一个没有 exit 的 close），
 * 而解一个截断的 tar 会**静默产出一棵看起来完整的残缺目录树**。
 * 走临时 tarball 时我们在解包前就从 stat 知道它该有多大。
 *
 * **不做 gzip、不加设置项**：SSH 自己有压缩；下载方向等于拿**生产服务器**的 CPU 换钱，
 * 而真正要搬的负载（jar / 镜像 / `.gz` 日志）本来就压不动；要可移植地控制压缩级别
 * 得用 `--use-compress-program='gzip -1'`，白送一个注入面。存储式还让文件名恒定是 `.tar`。
 */

// ---------------------------------------------------------------------------
// 远端探测
// ---------------------------------------------------------------------------

export type TarFlavor = 'gnu' | 'bsd' | 'busybox' | 'unknown'

export interface PackProbe {
  tarFlavor: TarFlavor
  hasMktemp: boolean
  /** 远端的 ${TMPDIR:-/tmp} */
  tmpDir: string
  /** 目录里的条目数（含目录本身，只用于过阈值，不求精确） */
  entryCount: number
  /** du -sk 的已分配块数 */
  sizeKb: number
  /** TMPDIR 所在文件系统的可用 KB；探不到为 null */
  freeTmpKb: number | null
  /** 源目录父目录所在文件系统的可用 KB；探不到为 null */
  freeSrcKb: number | null
}

/**
 * 一次只读探测。全部信息**在同一条 exec 里**拿回来 —— 绝不为了"值不值得打包"这个决策
 * 去 SFTP 遍历目录树（那正是打包要替代的开销）。
 *
 * 输出形状刻意做成 `OFSP:<KEY> <值>` 的单行键值，而不是照 monitor 那样的分段哨兵：
 * 每个字段都只有一行，键值行用一条正则就解完，也不必把 monitor 的 splitSections
 * 拖进 sftp 这一侧（那会造出一个没必要的依赖方向）。
 *
 * 两次 `df` 分开发、各带自己的键：POSIX df 接多个操作数时输出行与操作数的对应关系
 * 只靠顺序，按位置解析是那种"平时对、换个发行版就错"的代码。多一个进程，零额外往返。
 */
export function buildProbeScript(dir: RemotePath): string {
  const q = shQuote(dir)
  const parent = shQuote(remoteDirname(dir))
  return [
    `tar --version 2>&1 | head -n 1 | awk '{print "OFSP:TAR " $0}'`,
    `command -v mktemp >/dev/null 2>&1 && echo 'OFSP:MKTEMP yes' || echo 'OFSP:MKTEMP no'`,
    `printf 'OFSP:TMPDIR %s\\n' "\${TMPDIR:-/tmp}"`,
    `find ${q} 2>/dev/null | wc -l | awk '{print "OFSP:COUNT " $1}'`,
    `du -sk ${q} 2>/dev/null | awk '{print "OFSP:SIZEKB " $1}'`,
    `df -Pk "\${TMPDIR:-/tmp}" 2>/dev/null | awk 'NR==2{print "OFSP:FREETMP " $4}'`,
    `df -Pk ${parent} 2>/dev/null | awk 'NR==2{print "OFSP:FREESRC " $4}'`
  ].join('\n')
}

/**
 * 解析探测输出。纯函数。
 *
 * tar 风味的判定用录下来的真实首行（见 test/unit/packTransfer.test.ts）：
 *  - GNU tar 1.34 → `tar (GNU tar) 1.34`
 *  - bsdtar → `bsdtar 3.5.1 - libarchive 3.5.1`
 *  - BusyBox → `tar: unrecognized option '--version'` 之类的用法说明（走 2>&1 收进来）
 *  - 没装 → `sh: 1: tar: not found` / `command not found`
 * 认不出来一律 `unknown` —— 那会让 shouldPack 拒绝打包，方向是安全的。
 */
export function parseRemoteProbe(stdout: string): PackProbe {
  const get = (key: string): string | null => {
    const m = new RegExp(`^OFSP:${key} (.*)$`, 'm').exec(stdout)
    return m ? m[1].trim() : null
  }
  const num = (key: string): number | null => {
    const v = get(key)
    if (v === null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  const tarLine = get('TAR') ?? ''
  let tarFlavor: TarFlavor = 'unknown'
  if (/GNU tar/i.test(tarLine)) tarFlavor = 'gnu'
  else if (/bsdtar|libarchive/i.test(tarLine)) tarFlavor = 'bsd'
  else if (/busybox/i.test(tarLine)) tarFlavor = 'busybox'
  // BusyBox 的 tar 不认 --version，会吐用法说明；"not found" 则是真没装
  else if (/unrecognized option|invalid option|usage: tar|BusyBox/i.test(tarLine)) {
    tarFlavor = /not found|no such file/i.test(tarLine) ? 'unknown' : 'busybox'
  }

  return {
    tarFlavor,
    hasMktemp: get('MKTEMP') === 'yes',
    tmpDir: get('TMPDIR') ?? '',
    entryCount: num('COUNT') ?? 0,
    sizeKb: num('SIZEKB') ?? 0,
    freeTmpKb: num('FREETMP'),
    freeSrcKb: num('FREESRC')
  }
}

export interface PackDecision {
  pack: boolean
  /** 不打包时给出原因（会落进 task.notice，用户看得见） */
  reason?: string
  /** 打包时：临时 tarball 建在哪个目录下 */
  tmpBase?: RemotePath
  /** 打包时：探到的体积，用来放大打包/解包的超时 */
  sizeKb?: number
}

/**
 * 值不值得打包。纯函数。
 *
 * 每一条 `false` 都带原因，因为**降级必须是可解释的** —— "为什么这次没走打包"
 * 是这个功能最常被问的问题，而静默降级会让人以为功能没生效。
 */
export function shouldPack(
  probe: PackProbe,
  opts: { targetExists: boolean; conflictPolicy: string; remoteDir: RemotePath; topName: string }
): PackDecision {
  if (probe.tarFlavor === 'unknown') {
    return { pack: false, reason: '远端未找到可用的 tar，已改用逐文件传输' }
  }
  if (!probe.hasMktemp) {
    return { pack: false, reason: '远端没有 mktemp，无法安全地建临时文件，已改用逐文件传输' }
  }
  if (probe.entryCount < PACK_MIN_FILES) {
    return { pack: false, reason: `目录里只有 ${probe.entryCount} 项，打包省不出往返，已逐文件传输` }
  }
  /*
   * 与冲突策略联动。tar 解包天生是覆盖语义：`-k` 能表达 skip 但会让 GNU tar
   * 每撞一次就退 2，`rename` 根本表达不了。所以目标已存在而用户选的不是"覆盖"时
   * 一律不打包 —— 一条规则胜过一堆开关，而且绝不悄悄违反用户选的语义。
   */
  if (opts.targetExists && opts.conflictPolicy !== 'overwrite') {
    return { pack: false, reason: '本地已存在同名目录，为遵守冲突策略改用逐文件传输' }
  }
  /*
   * 顶层名必须原样落得了地。打包下载**没有** sanitizeLocalName 那一步（tar 里的成员名
   * 改不动），要是顶层名需要改写，解出来的目录名就和界面上那条 localPath 不一致
   * （"在文件夹中显示"会指到一个不存在的路径）。中文名过这条检查是原样通过的。
   */
  if (sanitizeLocalName(opts.topName) !== opts.topName) {
    return { pack: false, reason: '目录名在本机需要改写，已改用逐文件传输' }
  }
  const needKb = Math.ceil(probe.sizeKb * PACK_FREE_MARGIN) + PACK_FREE_SLACK_KB
  // 探不到可用空间时**不打包**：在远端 /tmp 上赌一把的代价是把生产服务器塞满
  const tmpOk = probe.freeTmpKb !== null && probe.freeTmpKb >= needKb
  const srcOk = probe.freeSrcKb !== null && probe.freeSrcKb >= needKb
  if (tmpOk) {
    // TMPDIR 是远端环境变量，内容不受我们控制 —— 它要进 shell 命令，必须过守卫
    const tmp = safePath(probe.tmpDir)
    if (tmp) return { pack: true, tmpBase: tmp }
    return { pack: false, reason: '远端 TMPDIR 不是一个可用的绝对路径，已改用逐文件传输' }
  }
  if (srcOk) return { pack: true, tmpBase: remoteDirname(opts.remoteDir) }
  return {
    pack: false,
    reason: '远端临时目录与源目录所在分区都放不下打包文件，已改用逐文件传输'
  }
}

/** 过得了守卫就返回，过不了给 null（shouldPack 是纯判定，不抛） */
function safePath(p: string): RemotePath | null {
  try {
    return assertSafeRemotePath(p, '远端临时目录')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 远端命令
// ---------------------------------------------------------------------------

/**
 * 建临时 tarball。
 *
 * **临时文件名必须由 `mktemp` 生成**（0600、无竞态、认 TMPDIR）。在世界可写的 `/tmp` 里
 * 用固定名是教科书级的符号链接攻击靶子 —— 远端的本地用户预先把那个名字建成软链，
 * tar 就写穿过去了。也正因为用 mktemp，**这一片不需要任何新的字符串设置**，
 * 而"任何字符串设置都是渲染进程可控输入"（settings:set 只按 z.record 校验）。
 *
 * 远端词汇只用 POSIX 交集 `-c -f -C --`，**一律不用长选项**（BusyBox 认不全）。
 * 不加 `-h`（保留软链，避免环与体积爆炸），不加 `--numeric-owner/--xattrs/--acls/--selinux`。
 *
 * 退出码的处置是这条命令唯一的复杂之处：**GNU tar 退 1 不是失败** ——
 * 约定是 0 正常 / 1 有差异 / ≥2 致命，而"file changed as we read it"（树里有活跃日志）
 * 就是 1。不写这条，打包任何含日志的目录都会莫名中止。所以只有 `> 1` 才删包并报错。
 */
export function buildPackCommand(dir: RemotePath, tmpBase: RemotePath): string {
  const parent = shQuote(remoteDirname(dir))
  const name = shQuote(remoteBasename(dir))
  const template = shQuote(`${tmpBase === '/' ? '' : tmpBase}/ofs-pack.XXXXXXXX`)
  return [
    `t=$(mktemp ${template}) || exit 90`,
    `tar -c -f "$t" -C ${parent} -- ${name}`,
    'rc=$?',
    'if [ $rc -gt 1 ]; then rm -f "$t"; exit 91; fi',
    `printf 'OFSP:PATH %s\\n' "$t"`,
    `printf 'OFSP:RC %s\\n' "$rc"`
  ].join('\n')
}

/** 从打包命令的输出里取回临时文件路径与 tar 的退出码 */
export function parsePackOutput(stdout: string): { path: string | null; tarRc: number | null } {
  const p = /^OFSP:PATH (.*)$/m.exec(stdout)
  const r = /^OFSP:RC (\d+)$/m.exec(stdout)
  return { path: p ? p[1].trim() : null, tarRc: r ? Number(r[1]) : null }
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

export interface PlanDeps {
  conn: ExecCapable
  sessionId: SessionId
  dir: RemotePath
  localPath: string
  conflictPolicy: string
}

/**
 * 探测 + 判定。探测结果按 sessionId 缓存 —— 同一次多选下载会连着问好几遍，
 * 而 tar 版本与 TMPDIR 在一条连接的生命周期里不会变。
 * 空间与文件数**不缓存**（它们每次都可能不一样），所以缓存只存那三个静态字段。
 */
const staticCache = new Map<SessionId, Pick<PackProbe, 'tarFlavor' | 'hasMktemp' | 'tmpDir'>>()

export function clearProbeCache(sessionId: SessionId): void {
  staticCache.delete(sessionId)
}

export async function planPackedDownload(deps: PlanDeps): Promise<PackDecision> {
  const localTar = findLocalTar()
  if (!localTar) {
    return {
      pack: false,
      reason:
        process.platform === 'win32'
          ? '本机找不到 tar.exe（需要 Windows 10 1803 或更高），已改用逐文件传输'
          : '本机找不到 tar，已改用逐文件传输'
    }
  }
  const dir = assertSafeRemotePath(deps.dir, '打包目录')
  let probe: PackProbe
  try {
    const result = await execOnce(deps.conn, buildProbeScript(dir), {
      timeoutMs: PACK_PROBE_TIMEOUT_MS
    })
    probe = parseRemoteProbe(result.stdout)
  } catch (err) {
    // 探测失败（超时、通道开不出来）一律退回逐文件：它是"锦上添花"的路，不该拖垮传输
    log.warn(`probe failed: ${err instanceof Error ? err.message : String(err)}`)
    return { pack: false, reason: '远端探测未完成，已改用逐文件传输' }
  }

  const cached = staticCache.get(deps.sessionId)
  if (cached && probe.tarFlavor === 'unknown') Object.assign(probe, cached)
  else {
    staticCache.set(deps.sessionId, {
      tarFlavor: probe.tarFlavor,
      hasMktemp: probe.hasMktemp,
      tmpDir: probe.tmpDir
    })
  }

  const targetExists = await fs
    .stat(longPath(deps.localPath))
    .then(() => true)
    .catch(() => false)
  const decision = shouldPack(probe, {
    targetExists,
    conflictPolicy: deps.conflictPolicy,
    remoteDir: dir,
    topName: remoteBasename(dir)
  })
  // 打包/解包的超时按体积放大，所以把探到的体积一起带出去
  return decision.pack ? { ...decision, sizeKb: probe.sizeKb } : decision
}

export interface PackedDownloadDeps {
  conn: ExecCapable
  sftp: SFTPWrapper
  task: TransferTask
  tmpBase: RemotePath
  /** 探测到的体积（KB），只用来放大打包/解包超时 */
  sizeKb: number
  /** 本地临时 tar 的落脚目录（%TEMP%/ofs-pack） */
  localTmpDir: string
  onProgress: (transferred: number) => void
  onPhase: (phase: TransferPhase, notice?: string) => void
}

/**
 * 跑一次打包下载。返回与 runTransfer **同形**的 `{promise, handle}`，
 * 于是队列那边把它存进同一个 `entry.handle` 就行。
 *
 * 暂停/取消的语义（诚实且简单）：
 *  - 传输阶段直接委托给内层 handle（那一段是真的可暂停可续传的）；
 *  - 打包/解包阶段**推迟到传输阶段生效**，取消则在阶段边界生效。
 *    远端 tar 已经在跑了，硬砍只会留下一个孤儿临时文件。
 *  - **暂停也会清掉临时包**，所以"继续"是从重新打包开始的（不是从断点续传那个 tar）。
 *    取舍：留着它能省一次打包，但一个被永久暂停的任务就在远端 /tmp 里留下一个大文件。
 *    宁可多打一次包。这条要写进文档。
 */
export function runPackedDownload(deps: PackedDownloadDeps): {
  promise: Promise<void>
  handle: WorkerHandle
} {
  const { conn, sftp, task, tmpBase, sizeKb, localTmpDir, onProgress, onPhase } = deps
  const state = { paused: false, canceled: false }
  let inner: WorkerHandle | null = null

  const handle: WorkerHandle = {
    pause: () => {
      state.paused = true
      inner?.pause()
    },
    cancel: () => {
      state.canceled = true
      inner?.cancel()
    }
  }

  const abortAtBoundary = (): void => {
    if (state.canceled) throw new TransferAborted('canceled')
  }

  const promise = (async (): Promise<void> => {
    const localTar = findLocalTar()
    if (!localTar) throw new Error('本机找不到 tar')
    const dir = assertSafeRemotePath(toRemotePath(task.remotePath), '打包目录')
    const top = remoteBasename(dir)
    let remoteTar: RemotePath | null = null
    let localArchive: string | null = null

    try {
      // ---- 打包 ----
      abortAtBoundary()
      onPhase('packing')
      const packed = await execOnce(conn, buildPackCommand(dir, tmpBase), {
        timeoutMs: tarTimeoutMs(sizeKb * 1024)
      })
      if (packed.code === 90) throw new Error('远端 mktemp 失败，无法建立打包用的临时文件')
      if (packed.code === 91) throw new Error(`远端打包失败：${firstLine(packed.stderr)}`)
      if (packed.code !== 0) throw new Error(`远端打包未完成（退出码 ${packed.code}）`)
      const { path: tarPath, tarRc } = parsePackOutput(packed.stdout)
      if (!tarPath) throw new Error('远端打包没有回报临时文件路径')
      // mktemp 给回来的路径要再过一遍守卫才能进下一条命令 / SFTP 请求
      remoteTar = assertSafeRemotePath(tarPath, '打包临时文件')
      if (tarRc === 1) {
        onPhase('packing', '打包过程中有文件被修改，归档内容可能不是同一时刻的快照')
      }

      // ---- 量一下它该有多大（解包前就知道，这正是不走流式的理由） ----
      const info = await statSize(sftp, remoteTar)
      if (!info.exists || info.size <= 0) throw new Error('远端打包文件不存在或为空')
      task.size = info.size

      // ---- 传输 ----
      abortAtBoundary()
      if (state.paused) throw new TransferAborted('paused')
      onPhase('transferring')
      await fs.mkdir(localTmpDir, { recursive: true })
      localArchive = join(localTmpDir, `${task.id}.tar`)
      const innerRun = runTransfer({
        sftp,
        task: { ...task, remotePath: remoteTar, localPath: localArchive, size: info.size },
        resume: false,
        onProgress
      })
      inner = innerRun.handle
      await innerRun.promise
      inner = null
      task.transferred = info.size

      // ---- 解包（先验完整性与容器性，再动用户目录） ----
      abortAtBoundary()
      onPhase('extracting')
      const timeout = tarTimeoutMs(info.size)
      const listed = await listTarEntries(localTar, localArchive, timeout)
      if (!listed.ok) {
        throw new Error(`归档校验失败（可能已损坏或被截断）：${firstLine(listed.stderr)}`)
      }
      const check = checkTarEntries(listed.names, top)
      if (check.unsafe.length > 0) {
        throw new Error(
          `归档里有 ${check.unsafe.length} 条成员越出目标目录，已放弃解包：${check.unsafe
            .slice(0, 3)
            .join(', ')}`
        )
      }
      const destDir = dirname(task.localPath)
      await fs.mkdir(longPath(destDir), { recursive: true })
      const outcome = await extractTar(localTar, localArchive, destDir, timeout)
      if (!outcome.ok) throw new Error(`解包失败：${outcome.fatal.slice(0, 2).join(' | ')}`)
      if (outcome.skippedSymlinks > 0) {
        onPhase('extracting', `解包完成，跳过 ${outcome.skippedSymlinks} 个符号链接（Windows 无法创建）`)
      }
    } finally {
      // ---- 清场：无论成败都要做，否则远端 /tmp 与本机 %TEMP% 各留一份 ----
      onPhase('cleanup')
      if (remoteTar) {
        // 用 SFTP unlink 而不是再发一条 rm：传输句柄现成，少一条 shell 命令
        await sftpUnlink(sftp, remoteTar).catch((err: unknown) =>
          log.warn(`remote temp cleanup failed: ${String(err)}`)
        )
      }
      if (localArchive) {
        await fs.rm(longPath(localArchive), { force: true }).catch(() => {})
      }
    }
  })()

  return { promise, handle }
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
}
