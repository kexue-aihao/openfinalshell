import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, shell } from 'electron'
import type { SFTPWrapper, Stats } from 'ssh2'
import { MAX_EDIT_BYTES } from '@shared/constants'
import type { SessionId } from '@shared/types'
import { detectEolRegression, looksBinary, tempRelPath } from './editGuards'
import { sha256Hex, watchLocalFile, type WatchHandle } from './localFileWatch'
import { longPath, remoteBasename, remoteDirname, remoteJoin, toRemotePath } from './remotePath'
import { readRemoteTextFile } from './remoteTextFile'
import {
  readRemoteFile,
  sftpChmod,
  sftpPosixRename,
  sftpRename,
  sftpStat,
  sftpUnlink,
  writeRemoteFile
} from './sftpLowLevel'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('edit')

/**
 * "在本机编辑器里改远端文件"的编排层：拉下来 → 落到临时目录 → 起编辑器 → 盯存盘 → 原子写回。
 *
 * 为什么不走 TransferQueue：那条路是为"批量传大文件"设计的，五条特性全和"改一个 20KB 的
 * nginx.conf"冲突 —— enqueue 是同步 fire-and-forget（拿不到单个任务的完成时机，而这里必须
 * 知道写回成功没有）、受并发闸门排在大传输后面（用户按了 Ctrl+S 要等十分钟）、上传强制
 * 0o644（把 0600 的私钥文件改成全局可读）、覆盖时"先删后改名"（远端文件会短暂不存在）、
 * 还会强行弹出传输抽屉。所以这里自己走主连接上常驻的那条浏览用 SFTP：
 * 为编辑一个小文件再拨一条 SSH 连接不值得。
 *
 * 全模块的路径纪律：本地路径 100% 在这里从 (sessionId, remotePath) 派生，对外的任何接口
 * 都不接受本地路径。这一条是 shell.openPath / spawn 能安全使用的唯一理由（见 launchEditor）。
 */

/** 同时编辑上限：每条编辑常驻一个 fs.watch + 一个 StatWatcher，20 条已经远超正常用法 */
const MAX_CONCURRENT_EDITS = 20

/**
 * 冲突检测的分水岭：256KB 以内比内容哈希（顺带能做行尾回归判定），以上只比 size+mtime。
 * 为什么不一律比哈希：每次 Ctrl+S 都把远端整个文件重下一遍只为了算个哈希，
 * 在 2MB 上就是一次几百毫秒的白等；而"编辑期间被第三方改动"这种事，size+mtime 已经能抓住
 * 绝大多数（真要构造出 size 与 mtime 都不变的改动，得刻意回写同长度内容再 touch 回去）。
 */
const HASH_COMPARE_MAX_BYTES = 256 * 1024

/**
 * 临时根的名字前缀。**必须配 mkdtemp 用，不许换回固定名**。
 *
 * 曾经是固定的 'openfinalshell-edit'，那是个能被同机非特权用户利用的洞：本项目发布目标
 * 含 Linux（见 electron-builder.yml），那里 app.getPath('temp') 就是全局可写的 /tmp。
 * 攻击者只要在受害者第一次编辑前 `mkdir -m 777 /tmp/openfinalshell-edit`，
 * 这个父目录就归他了 —— mkdir({recursive:true}) 对已存在的目录既不查属主也不拒符号链接，
 * 而 <hash> 子目录他根本不需要预测（父目录可列可写，把它换成指向别处的软链就行）。
 * 于是用户以 root 编辑 /etc/shadow 时，明文副本落到攻击者选的路径上。
 *
 * mkdtemp 把这三条一次性堵死：名字带 6 位随机、创建时天然 0700、已存在就重试 ——
 * 没有"复用别人建好的目录"这条路可走，也就无从抢占。
 * 代价是临时根不再跨进程稳定（每次启动换一个），可以接受：编辑本来就不跨重启存活，
 * 上次崩掉留下的明文副本由 purgeStaleTempDirs 在启动时清掉。
 */
const TEMP_ROOT_PREFIX = 'ofs-edit-'

/**
 * 临时根里记"我归哪个 pid"的小文件（内容就是 String(process.pid)）。
 * purgeStaleTempDirs 靠它判某个根还有没有主 —— 为什么不能靠名字见 purgeIfOwnerGone。
 * 名字带前导点：根下面除了它全是 16hex 的 <hash> 子目录，撞不上。
 */
const TEMP_OWNER_FILE = '.ofs-owner'

/**
 * 截断闸门的两条判据（"新内容 0 字节"与"baseline ≥ 4KB 且缩到 1/4 以下"）。
 *
 * 为什么是这两条、而不是一个笼统的比例：
 * - **0 字节那一档与文件大小无关**，所以它不设尺寸门槛：40 字节的 .env 被截成 0
 *   和 20KB 的 nginx.conf 被截成 0 一样致命 —— 正在 reload 的服务读到的是空配置。
 * - **比例判据必须配一个尺寸门槛**：几百字节的 .env / authorized_keys 里删掉一多半
 *   是日常编辑，在那个尺度上任何比例都是误报；4KB 往上的配置文件（nginx.conf、
 *   sshd_config、docker-compose.yml 这一档起步就是几 KB）一次存盘掉到 1/4 以下，
 *   只剩"编辑器只写了一半"和"手滑全选删"两种可能，两种都该先问一句。
 * - 1/4 而不是 1/2：1/2 会把"把一个长配置精简掉一多半"这种真实操作也拦下来。
 */
const SHRINK_BASELINE_FLOOR_BYTES = 4 * 1024
const SHRINK_RATIO_DIVISOR = 4

/** 远端临时名/备份名的后缀长度受此约束：绝大多数文件系统单段上限 255 字节 */
const MAX_REMOTE_NAME_BYTES = 255

/**
 * 远端临时名的排他创建尝试次数。撞名的来源只有两种：上次进程崩在写临时文件之后留下的残留、
 * 或者有人在猜名字。换一个新的 8hex 后缀重试比"unlink 掉再用 'w' 建"安全得多 ——
 * 后者等于把 EXCL 挡住的那个竞态窗口重新开出来，还可能删掉别人的文件。
 * 3 次之后放弃并报错：SFTP v3 分不出"撞名"和"目录不可写"（一律 SSH_FX_FAILURE），
 * 真是权限问题时多试两次也只是两个 RTT。
 */
const REMOTE_TEMP_ATTEMPTS = 3

export type EditId = string

/**
 * downloading → editing → uploading → editing（存盘成功回到 editing）。
 * 岔路四条：conflict（远端被改）、blocked（服务器不支持原子替换）、
 * shrink（本地内容急剧变短，像是编辑器只写了一半）、error（其它失败），
 * 四者都停在"本地内容还在、远端一个字节没动"的状态上等用户裁决，
 * 出口也都是同一个强制覆盖入口（forceSave）或 stop。
 * closed 只作为事件出现（停止编辑时发一次），list() 里不会再有它。
 */
export type RemoteEditState =
  | 'downloading'
  | 'editing'
  | 'uploading'
  | 'conflict'
  | 'blocked'
  | 'shrink'
  | 'error'
  | 'closed'

export type EolWarning = 'lfToCrlf' | 'crlfToLf'

export interface RemoteEditInfo {
  id: EditId
  sessionId: SessionId
  /** 用户点开的那条路径（软链就是软链本身）：注册表 key 与界面展示都用它 */
  remotePath: string
  /** 真正读写的路径：软链解析后的真身，与 remotePath 相同表示不是软链 */
  resolvedPath: string
  /**
   * 本地落地的绝对路径。出得去、进不来 —— 界面可以显示它，但任何 IPC 接口都不接受
   * 本地路径回传，否则渲染进程就能指使 main 侧去打开/覆盖任意文件。
   */
  localPath: string
  state: RemoteEditState
  /** 中文说明（失败原因、blocked 原因）。main 侧文案硬编码中文，沿用既有约定 */
  message?: string
  /** 存盘把行尾整体翻面了：只警告，不替用户改回去 */
  eolWarning?: EolWarning
  /** 最近一次已知的内容长度 */
  size: number
  savedAt?: number
  createdAt: number
}

export interface RemoteEditDeps {
  /** 取该会话的 SFTP 通道；默认走主连接上常驻的那条浏览用 SFTP */
  getSftp: (sessionId: SessionId) => Promise<SFTPWrapper>
  /** 起外部编辑器；单测里是 no-op，绝不能真弹一个记事本出来 */
  openEditor: (absPath: string) => Promise<void>
  /** 临时落地根目录，默认 app.getPath('temp')；单测换成自己的目录，不碰用户 %TEMP% */
  tempRoot: () => string
  /** 存盘监视，单测里换成手动触发的假实现（真 watcher 的行为在 localFileWatch 的单测里钉） */
  watch: typeof watchLocalFile
}

interface Baseline {
  /** 远端内容哈希；size > HASH_COMPARE_MAX_BYTES 时为 null（那时只比属性） */
  sha: string | null
  /** 打开时（或上次写回时）的远端内容，只为行尾回归判定留着，大文件同样不留 */
  buf: Buffer | null
  size: number
  /**
   * 远端 mtime；**null 表示"没问到"**（写回之后那次 stat 打不通就是这种情况）。
   * 为什么不能拿 0 顶替：0 是一个合法的 mtime 值，而真实 mtime 必然不等于 0 ——
   * 大文件（sha 为 null）只比 size+mtime，一旦 baseline 里留了个假的 0，
   * 此后**每一次**存盘都被判成"远端被人改过"，而且再没有机会自己修正。
   * 误判冲突比漏判一次危险得多：它会把用户逼到 forceSave 那条"无条件覆盖别人改动"的路上。
   */
  mtime: number | null
  /** 权限位（去掉文件类型位），写回时用来重建同样的 mode */
  mode: number
}

interface Entry {
  info: RemoteEditInfo
  baseline: Baseline
  watch: WatchHandle | null
  /** 临时目录绝对路径（停止编辑时整个删掉） */
  tempDir: string
  /**
   * 本地最近一次存盘的内容，等着写回。
   * 冲突/blocked/shrink/失败时**留着不清**：用户点"重试"（retry，带冲突检测）或"仍然覆盖"
   * （forceSave，跳过检测）就是拿它再走一遍 —— 网络抖一下不该逼他回编辑器再存一遍盘。
   * 写回成功后也只在"这一趟写的正是它"时才清（见 writeBack 末尾那段注释）。
   */
  pending: Buffer | null
  /** 串行闸门：同一条编辑的写回不许并发，否则两次 rename 抢同一个目标、baseline 也会被写乱 */
  tail: Promise<void>
  closed: boolean
}

export class RemoteEditManager {
  private readonly edits = new Map<EditId, Entry>()
  private readonly listeners = new Set<(info: RemoteEditInfo) => void>()

  /** 本进程独占的临时根（懒创建一次，见 ensureTempRoot）；stopAll 之后回到 null */
  private tempRootDir: string | null = null
  /**
   * 上面那个目录的名字（ofs-edit-XXXXXX）。purgeStaleTempDirs 靠它避开"自己正在用的那个" ——
   * 但它只认得出**自己**，认不出别的活着的实例，那一半靠根里的 pid 标记（见 purgeIfOwnerGone）。
   */
  private tempRootName: string | null = null

  constructor(private readonly deps: RemoteEditDeps) {}

  /**
   * 状态广播。本模块**不**直接 emit 到渲染进程：EventMap 的 channel 归接线层管，
   * 这里只负责"有变化就喊一声"，谁转发、转发成哪个 channel 由接线层决定。
   * 顺带让单测不必为了收状态去 mock electron。
   */
  onState(listener: (info: RemoteEditInfo) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): RemoteEditInfo[] {
    return [...this.edits.values()].map((e) => ({ ...e.info }))
  }

  /**
   * 打开远端文件进编辑器。同一会话下同一条路径重复打开会复用同一条编辑
   * （同一份临时文件、同一个 watcher），只是把编辑器再唤一次。
   */
  async open(sessionId: SessionId, remotePath: string): Promise<RemoteEditInfo> {
    const key = toRemotePath(remotePath)
    const existing = this.find(sessionId, key)
    if (existing) {
      // 用户之所以再点一次，通常是编辑器窗口被埋在后面或者他自己关掉了 —— 再唤一次；
      // 还在 downloading 时本地文件都还没落地，唤了只会让编辑器报"文件不存在"
      if (existing.info.state !== 'downloading') void this.launch(existing)
      return { ...existing.info }
    }
    if (this.edits.size >= MAX_CONCURRENT_EDITS) {
      throw new Error(`同时编辑的文件不能超过 ${MAX_CONCURRENT_EDITS} 个，请先停止一些再试`)
    }

    const id = randomUUID()
    const entry: Entry = {
      info: {
        id,
        sessionId,
        remotePath: key,
        resolvedPath: key,
        localPath: '',
        state: 'downloading',
        size: 0,
        createdAt: Date.now()
      },
      baseline: { sha: null, buf: null, size: 0, mtime: null, mode: 0o644 },
      watch: null,
      tempDir: '',
      pending: null,
      tail: Promise.resolve(),
      closed: false
    }
    // 先占位再干活：并发闸门要在 await 之前就把额度算上，否则一次多选 50 个文件
    // 会让 50 条 open 全都通过 size 检查
    this.edits.set(id, entry)
    this.publish(entry)

    try {
      await this.download(entry)
      this.setState(entry, 'editing')
      void this.launch(entry)
      return { ...entry.info }
    } catch (err) {
      // 打开失败不留残条：错误会随 invoke 抛回渲染进程，界面弹一次就够了；
      // 留个 error 态在列表里既占着 20 个的额度，还得让用户手动清
      this.edits.delete(id)
      entry.closed = true
      await this.removeTemp(entry)
      this.setState(entry, 'closed', message(err))
      throw err
    }
  }

  /**
   * 重试上一次没写成的存盘：**保留全部冲突检测**，只是把留在手里的 pending 再走一遍写回。
   *
   * 为什么必须和 forceSave 分成两个入口：error 态最常见的成因是可重试的瞬时故障
   * （重连中的"会话未就绪"、网络抖一下），而 forceSave 那条路是跳过冲突检测的 ——
   * 只给一个出口，等于一次网络抖动就把用户推上"无条件覆盖别人改动"。
   * conflict / blocked 是"已经查清楚了、需要用户裁决"的状态，走这条重试多半还是同样的结论，
   * 但那也是正确的结论（远端确实被改过），不该由这里替他决定。
   */
  async retry(id: EditId): Promise<void> {
    const entry = this.requirePending(id)
    return this.serialize(entry, () => this.save(entry, false))
  }

  /**
   * 用户显式点"仍然覆盖"：跳过冲突检测与截断闸门，并且允许在服务器不支持原子替换时退化。
   * 这是 blocked / conflict / shrink 状态唯一的出口（另一个出口是 stop）；error 态优先用 retry。
   */
  async forceSave(id: EditId): Promise<void> {
    const entry = this.requirePending(id)
    return this.serialize(entry, () => this.save(entry, true))
  }

  /**
   * retry / forceSave 的共同前置。pending 为空时**抛错**而不是静默返回：
   * 这两个入口都只由用户点按钮触发，"点了完全没反应（没状态变化、没提示、没报错）"
   * 是最难排查的一类 bug —— 界面拿到一句人话至少能显示出来。
   * 真的走到这里通常意味着状态过期了（比如另一次存盘已经把内容写上去了），刷一下列表即可。
   */
  private requirePending(id: EditId): Entry {
    const entry = this.edits.get(id)
    if (!entry) throw new Error('该编辑已结束')
    if (!entry.pending) throw new Error('没有待保存的内容（可能已经写回成功了），请刷新后再看')
    return entry
  }

  /** 停止编辑：关 watcher、删临时目录（best-effort），并广播一次 closed */
  async stop(id: EditId): Promise<void> {
    const entry = this.edits.get(id)
    if (!entry) return
    this.edits.delete(id)
    entry.closed = true
    // 先关 watcher 再删目录：反过来的话删除动作本身会触发一串目录事件，
    // 白跑一遍防抖与重试预算
    entry.watch?.close()
    entry.watch = null
    this.setState(entry, 'closed')
    await this.removeTemp(entry)
  }

  /** 会话关闭/断开：该会话下所有编辑作废（远端都没了，留着 watcher 只会在存盘时报错） */
  async stopBySession(sessionId: SessionId): Promise<void> {
    const ids = [...this.edits.values()]
      .filter((e) => e.info.sessionId === sessionId)
      .map((e) => e.info.id)
    await Promise.all(ids.map((id) => this.stop(id)))
  }

  /** 退出应用时清场：临时目录里留着的是远端文件的明文副本，不该跨进程生命周期留在盘上 */
  async stopAll(): Promise<void> {
    await Promise.all([...this.edits.keys()].map((id) => this.stop(id)))
    /**
     * 连本进程那个临时根一起删掉 —— 每条编辑的 <hash> 子目录 stop 时已经删了，
     * 但根目录自己还在，不删就是每次启动在 %TEMP% 下多留一个空的 ofs-edit-xxxxxx。
     * 先清缓存再删：万一之后又有人调 open（正常退出流程不会），
     * ensureTempRoot 会重新 mkdtemp 一个，而不是往一个已经删掉的路径里写。
     */
    const root = this.tempRootDir
    this.tempRootDir = null
    this.tempRootName = null
    // maxRetries 的理由见 purgeIfOwnerGone：删不掉就等于把明文副本留在盘上
    if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }

  /**
   * 清掉**已经没有主**的临时根（上次崩溃、或被任务管理器杀掉时没走到 stopAll 的那些）。
   * 里面躺着的是远端文件的明文副本 —— 包括 /etc/shadow 这种，不能任它在 %TEMP% 下长住。
   *
   * 接线层应当在启动路径里调一次（await 不必要，失败也不该拦住启动）。
   * 逐个 catch：某个残留目录被别的进程占着句柄（Windows）删不掉是常态，
   * 不能因为一个失败就放过其余的。
   */
  async purgeStaleTempDirs(): Promise<void> {
    const parent = this.deps.tempRoot()
    /**
     * 先把自己的根建出来，这一步不是顺手 —— 它是"别删自己"这条自保分支能生效的前提。
     * 真实调用点（src/main/index.ts 的启动路径）在**任何一次编辑之前**，那时 tempRootName
     * 还是 null，`name !== null` 对所有目录都成立，自保分支在生产里等于是死的。
     * 顺带让本进程的根与那个 pid 标记在启动时就落地：别的实例来 purge 时才认得出我们活着。
     */
    let mine: string | null
    try {
      this.ensureTempRoot()
      mine = this.tempRootName
    } catch (err) {
      // 连自己的根都建不出来（temp 不可写/不存在）：这时去删别人的目录没有意义，
      // 而且判活要读的那个 pid 文件也不会有人写得进去，宁可整趟不做
      log.warn(`ensure temp root failed, skip purge: ${message(err)}`)
      return
    }
    let names: string[]
    try {
      names = await fs.readdir(parent)
    } catch {
      // temp 根本身读不到（权限/不存在）：没什么可清的
      return
    }
    await Promise.all(
      names
        .filter((name) => name.startsWith(TEMP_ROOT_PREFIX) && name !== mine)
        .map((name) => purgeIfOwnerGone(join(parent, name)))
    )
  }

  // ---------------- 打开 ----------------

  private find(sessionId: SessionId, remotePath: string): Entry | undefined {
    return [...this.edits.values()].find(
      (e) => e.info.sessionId === sessionId && e.info.remotePath === remotePath
    )
  }

  private async download(entry: Entry): Promise<void> {
    const { sessionId, remotePath } = entry.info
    const sftp = await this.deps.getSftp(sessionId)

    /**
     * 软链解析与三道门（类型 / 尺寸 / 二进制）在 remoteTextFile.ts —— 内置编辑器的只读查看
     * 走的是同一份。别把它抄回来：那三条每一条都是踩出来的（尤其软链那条，
     * 不解析的话 rename 会把软链本身换成普通文件），两份实现漂开就会有一边写坏文件。
     */
    const { resolvedPath: resolved, buf, stat } = await readRemoteTextFile(sftp, remotePath)
    entry.info.resolvedPath = resolved

    const local = await this.land(entry, buf)
    entry.info.localPath = local
    entry.info.size = buf.length
    entry.baseline = {
      sha: buf.length <= HASH_COMPARE_MAX_BYTES ? sha256Hex(buf) : null,
      buf: buf.length <= HASH_COMPARE_MAX_BYTES ? buf : null,
      size: stat.size,
      mtime: stat.mtime,
      mode: stat.mode & 0o7777
    }

    /**
     * watcher 必须在起编辑器之前挂好，否则手快的用户/自动格式化插件的第一次存盘就丢了。
     * initialSha256 必须是刚落地那份内容的哈希 —— 传别的值会让落地那次写入被当成存盘。
     */
    entry.watch = this.deps.watch(local, sha256Hex(buf), (localBuf) => {
      if (entry.closed) return
      entry.pending = localBuf
      void this.serialize(entry, () => this.save(entry, false))
    })
  }

  /**
   * 临时落地：路径完全由 (sessionId, remotePath) 派生，一编辑一目录（localFileWatch 盯目录的前提）。
   *
   * 注意用的是原始 remotePath 而不是 resolved：同一条软链重复打开要落到同一处；
   * 代价是"软链和它的真身同时被打开"会变成两条独立编辑，靠冲突检测兜住（后存的那条会报冲突）。
   */
  private async land(entry: Entry, buf: Buffer): Promise<string> {
    const rel = tempRelPath(entry.info.sessionId, entry.info.remotePath)
    const root = this.ensureTempRoot()
    // longPath 必须对拼好的绝对路径做：tempRelPath 不限制文件名长度，
    // temp 根 + 16 hex + 一个超长 basename 足够顶穿 MAX_PATH
    const dir = longPath(join(root, rel.dir))
    const file = longPath(join(root, rel.dir, rel.file))
    entry.tempDir = dir
    /**
     * mode 必须显式给 0o700，不能吃默认值。临时根被外力删掉之后（同账号下另一个实例的
     * purge、systemd-tmpfiles、用户手动清 /tmp）这一次 recursive mkdir 会把**根**
     * 和 <hash> 子目录一起建出来 —— 不带 mode 就是按 0o777 & ~umask（常见 0755）建，
     * mkdtemp 那个 0700 就这么丢了：同机其他用户能列目录拿到远端 basename，
     * 而 shadow / id_rsa / prod.env 这种名字本身就是情报（内容还是 0600，靠 writeExclusive）。
     */
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await writeExclusive(file, buf)
    return file
  }

  /**
   * 本进程独占的临时根，懒创建一次然后缓存。
   *
   * 为什么必须 mkdtemp 而不是固定名（安全前提）见 TEMP_ROOT_PREFIX 的注释。
   * 为什么用**同步**版：两条 open 并发时，异步 mkdtemp 之间的 await 会让两边都看到
   * tempRootDir === null，于是建出两个根、其中一个从此没人管（也没人删）。
   * mkdtempSync 让"查缓存 → 建 → 写缓存"整段不可被打断，从根上没有这个竞态；
   * 代价是一次几毫秒的同步 IO，只在每个进程的第一次编辑发生一遍。
   *
   * 创建完再解一次真实长路径：Windows 的 %TEMP% 常常是 8.3 短名
   * （本机就是 C:\Users\ADMINI~1\...），短名会顺着 join 传染给下游 ——
   * localFileWatch 自己解了所以不至于把主进程 abort 掉，但任何拿路径做字符串比较/
   * 去重的地方都会各踩一遍（短名与长名不相等）。在源头解一次最省事。
   * 注意只有 .native 走 GetFinalPathNameByHandle 才解短名，普通 realpathSync 不解。
   */
  private ensureTempRoot(): string {
    if (this.tempRootDir !== null) return this.tempRootDir
    const created = mkdtempSync(join(this.deps.tempRoot(), TEMP_ROOT_PREFIX))
    /**
     * 记下所属 pid：purgeStaleTempDirs 靠它判"这个根还有主吗"（见 purgeIfOwnerGone），
     * 别的实例才不会把我们正在编辑的目录当成陈旧残留删掉。同步写，与 mkdtempSync 同一个
     * 理由（这一段整体不许被打断）；0600 是因为它就在一个 0700 的目录里，没必要更松。
     * 写失败只 warn 不抛：目录已经建好了、编辑照样能进行，代价只是别的实例可能误清这个根 ——
     * 刚建成功的目录里写几个字节失败几乎不会发生，为它把整条编辑挡掉不值。
     */
    try {
      writeFileSync(join(created, TEMP_OWNER_FILE), String(process.pid), { mode: 0o600 })
    } catch (err) {
      log.warn(`write owner mark in ${created} failed: ${message(err)}`)
    }
    let resolved = created
    try {
      resolved = realpathSync.native(created)
    } catch {
      // 解不出来（权限怪）就用原值：目录刚建成功，短名只是让下游多绕点弯，不至于不能用
    }
    // 名字取自**创建时**那个路径：purge 扫的是 deps.tempRoot() 下的目录名，
    // 拿解过长名的 resolved 去取 basename 也一样，但没必要多一次转换
    this.tempRootName = basename(created)
    this.tempRootDir = resolved
    return resolved
  }

  // ---------------- 写回 ----------------

  /** 同一条编辑的所有写回排成一队；前一个失败也要继续跑下一个 */
  private serialize(entry: Entry, job: () => Promise<void>): Promise<void> {
    const next = entry.tail.then(job, job)
    entry.tail = next.catch(() => {})
    return next
  }

  private async save(entry: Entry, force: boolean): Promise<void> {
    if (entry.closed) return
    const buf = entry.pending
    if (!buf) return

    /**
     * 本地内容也要过一遍闸门 —— 打开时是文本，存盘后可能已经不是了：
     * 记事本"另存为 UTF-16"会让整个文件塞满 NUL，直接写回去等于毁掉远端文件；
     * 有人往配置里粘了个 base64 大块也可能顶穿 2MB。这两种情况停下来报错比写回去好。
     */
    if (buf.length > MAX_EDIT_BYTES) {
      this.setState(entry, 'error', `本地文件已超过 ${MAX_EDIT_BYTES} 字节，拒绝写回`)
      return
    }
    if (looksBinary(buf)) {
      this.setState(entry, 'error', '本地文件已变成二进制（含 NUL 字节，可能被存成了 UTF-16），拒绝写回')
      return
    }
    // 改回原样再存盘（或者编辑器只是 touch 了一下）：远端内容与本地一致就没什么可写的
    if (entry.baseline.sha !== null && sha256Hex(buf) === entry.baseline.sha) {
      // 这里到上面取 buf 之间一次 await 都没有，pending 必然还是同一份，
      // 所以直接清是安全的 —— 隔着 await 的那处（writeBack 末尾）就必须比引用了
      entry.pending = null
      if (entry.info.state !== 'editing') this.setState(entry, 'editing')
      return
    }

    /**
     * 截断闸门：内容急剧变短时**一个字节都不写**，停在 shrink 等用户拿着实数确认。
     *
     * 挡的是 localFileWatch 判"写完了"的固有漏洞：它靠"连续两次读到同样内容"，两次之间只隔
     * 防抖 180ms + 确认 250ms = 430ms。编辑器原地分段改写（vim backupcopy=yes、
     * PowerShell Set-Content、慢盘或杀软介入）时，两段之间的停顿只要超过 430ms，
     * 半截内容就会被当成一次完成的存盘交上来 —— 实测最坏一档是 open('w') 截断后停顿 500ms
     * 才写第一个字节，于是**远端 nginx.conf 先被替换成 0 字节**再被补回来，
     * 正在 `reload` 的服务读到的就是空配置。
     *
     * 为什么不去 watcher 那边解决"写者到底写完没写完"：那需要知道文件上还有没有别人的写句柄，
     * Windows 上没有免原生依赖的办法（Node 也不让指定 share flags），而本项目零新增运行时依赖；
     * 拖长确认间隔只是把门槛挪一挪，挡不住慢盘。所以闸门放在写回这一侧：
     * 误拦一次"用户真的删了大半"只是多一次确认，漏放一次"半截内容"是远端配置先变成 0 字节。
     *
     * force 时不拦 —— 那正是用户看过"从 X 变成 Y"之后做的决定（与 blocked 完全同款的出口）。
     * 顺带一说这个状态不是死胡同：分段改写的后半段落盘后 watcher 会再报一次，
     * 那份完整内容照常过闸门写回去，用户可能根本没来得及看见这次 shrink。
     */
    if (!force && looksTruncated(entry.baseline.size, buf.length)) {
      this.setState(
        entry,
        'shrink',
        `内容从 ${entry.baseline.size} 字节变成 ${buf.length} 字节，缩得太多。` +
          '如果不是你自己删的，很可能是编辑器只写了一半就被读走了 —— ' +
          '确认要用这份内容覆盖远端吗？'
      )
      return
    }

    this.setState(entry, 'uploading')
    try {
      await this.writeBack(entry, buf, force)
    } catch (err) {
      log.warn(`save ${entry.info.resolvedPath} failed: ${message(err)}`)
      // pending 不清：error 最常见的成因是可重试的瞬时故障，用户点"重试"（retry）
      // 就是拿它再走一遍**带冲突检测**的写回；要跳过检测强行覆盖才走 forceSave
      this.setState(entry, 'error', message(err))
    }
  }

  private async writeBack(entry: Entry, buf: Buffer, force: boolean): Promise<void> {
    const sftp = await this.deps.getSftp(entry.info.sessionId)
    const target = entry.info.resolvedPath
    const stat = await sftpStat(sftp, target)

    if (!force) {
      // 目标没了（被删/被改名）也算冲突：盲目重建会把用户"我删了这个文件"的动作抹掉
      if (!stat) {
        this.setState(entry, 'conflict', '远端文件已不存在（可能被删除或改名），是否重新创建？')
        return
      }
      if (await this.remoteChanged(sftp, entry, stat)) {
        this.setState(entry, 'conflict', '远端文件在编辑期间被改动过，覆盖会丢掉那些改动')
        return
      }
    }

    /**
     * 权限保留：mode 取自刚才那次 stat（不是打开时的快照）—— 编辑期间管理员 chmod 过的话，
     * 用户想要的是"保持现在的权限"，不是"回到我打开时的权限"。目标不存在时退回打开时的 mode。
     * 说清代价：属主/组/ACL/SELinux 标签**不保留**。原子 rename 换的是 inode，
     * 新 inode 的属主是登录用户、SELinux 标签按目录默认策略重打 ——
     * 这是"绝不让远端文件短暂消失"必须付的价，想保住属主只能牺牲原子性。
     */
    const mode = stat ? stat.mode & 0o7777 : entry.baseline.mode

    // 行尾回归只警告不改写：替用户改回去是更大的恶（他也可能真想换行尾）
    const eol = entry.baseline.buf ? detectEolRegression(entry.baseline.buf, buf) : 'none'

    /**
     * 原子替换：先写到**同目录**下的隐藏临时名，再 posix-rename 覆盖。
     * 同目录是硬要求 —— 跨文件系统的 rename 一定失败，而 /tmp 与 /etc 常常不在一个挂载点上。
     *
     * 为什么先写临时文件才试 rename：ssh2 判断服务器支不支持 posix-rename 的唯一办法就是
     * 真调一次（未通告扩展时它在拼包前同步 throw，一个字节都没上线），而 rename 的源必须
     * 已经存在 —— 否则支持该扩展的服务器会回"no such file"，我们就分不清是"不支持"
     * 还是"源没了"。多写一个临时文件的代价换一个明确的判定，值。
     */
    /**
     * 动手写之前最后看一眼有没有被叫停：上面每一次 await（取 SFTP、stat、重读比哈希）
     * 都可能有几百毫秒，用户点"停止编辑"或者会话断开正好落在这段里 ——
     * 那之后往远端写就是拿一份用户已经放弃的内容去覆盖服务器。
     */
    if (entry.closed) return
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
      if (!force) {
        /**
         * 服务器不支持原子替换 → 停在 blocked，**绝不偷偷退化**。
         * 退化路径必然有一个"目标不存在/不完整"的瞬间，而 nginx -s reload 正好在那一瞬间
         * 读到空文件这种事是真的会发生。要不要承担这个风险由用户显式决定（forceSave）。
         * 到这里为止目标文件一个字节都没动，只是同目录下多了个临时文件 —— 顺手清掉。
         */
        await sftpUnlink(sftp, tmp).catch(() => {})
        entry.info.eolWarning = eol === 'none' ? undefined : eol
        this.setState(
          entry,
          'blocked',
          '服务器不支持原子替换（posix-rename 扩展），继续保存会让远端文件短暂不完整'
        )
        return
      }
      try {
        await degradedReplace(sftp, tmp, target, stat !== null)
      } catch (err) {
        // 与上面两条失败路径同样的收尾：临时文件不能留在人家目录里。
        // degradedReplace 抛错时 tmp 一定还在原地（它抛错的两个点都在 tmp 就位之前）
        await sftpUnlink(sftp, tmp).catch(() => {})
        throw err
      }
    }

    /**
     * 写完再显式 chmod 一次：临时文件是新建的，有些服务器会对 open 带的 mode 施加 umask。
     * umask 只会**去掉**权限位（不会加），所以中间不存在"短暂全局可写"的窗口，
     * 这一次 chmod 只是把被 umask 削掉的位补回来。
     * 失败不算保存失败 —— 内容已经就位了，退回 error 态反而会让用户以为没存上。
     */
    let chmodWarn = ''
    try {
      await sftpChmod(sftp, target, mode)
    } catch (err) {
      chmodWarn = `已保存，但权限位未能恢复（${message(err)}）`
      log.warn(`chmod ${target} failed: ${message(err)}`)
    }

    const after = await sftpStat(sftp, target)
    entry.baseline = {
      sha: buf.length <= HASH_COMPARE_MAX_BYTES ? sha256Hex(buf) : null,
      buf: buf.length <= HASH_COMPARE_MAX_BYTES ? buf : null,
      size: after?.size ?? buf.length,
      // stat 打不通时留 null（"未知"），绝不用 0 顶替 —— 理由见 Baseline.mtime
      mtime: after ? after.mtime : null,
      mode
    }
    /**
     * 只清"我这一趟写的正是它"的那份 pending。
     *
     * 上面有六到八次 await，用户完全可以在这期间再按一次 Ctrl+S：那次存盘把 pending 换成了
     * v2，并往队尾排了第二个 job。这里要是无条件清成 null，第二个 job 一跑就发现没内容可写、
     * 直接返回 —— 远端永远停在 v1，而且**不可自愈**：localFileWatch 那边 knownSha 早就推进到
     * sha(v2) 了，之后每次事件读到的哈希都等于 knownSha，一律当噪音挡掉，
     * 除非用户再动一次内容。界面看到的还是本趟的 editing，报"已写回远端"。
     * baseline 反过来必须无条件更新：远端现在确实是 v1 这份内容，下一个 job 拿它做冲突检测才对。
     */
    if (entry.pending === buf) entry.pending = null
    entry.info.size = buf.length
    entry.info.savedAt = Date.now()
    entry.info.eolWarning = eol === 'none' ? undefined : eol
    this.setState(entry, 'editing', chmodWarn || undefined)
  }

  /**
   * 远端在编辑期间变过没有。
   * 小文件重读比哈希（顺带对得上 baseline.buf 的行尾判定）；大文件只比 size+mtime ——
   * 为了算个哈希把 2MB 重下一遍，每次 Ctrl+S 都白等几百毫秒不值得。
   */
  private async remoteChanged(sftp: SFTPWrapper, entry: Entry, stat: Stats): Promise<boolean> {
    if (entry.baseline.sha !== null && stat.size <= HASH_COMPARE_MAX_BYTES) {
      const now = await readRemoteFile(sftp, entry.info.resolvedPath, HASH_COMPARE_MAX_BYTES)
      return sha256Hex(now) !== entry.baseline.sha
    }
    if (stat.size !== entry.baseline.size) return true
    /**
     * mtime 未知（上次写回后那次 stat 没打通）就只认 size 这一项，不因为"对不上"判冲突。
     * 拿一个假值去比必然不等，那等于把这条编辑永久钉在冲突态上 —— 用户只剩 forceSave
     * 可点，而 forceSave 是跳过冲突检测的：漏判一次远端改动，比每次都逼他无条件覆盖轻。
     */
    if (entry.baseline.mtime === null) return false
    return stat.mtime !== entry.baseline.mtime
  }

  // ---------------- 杂务 ----------------

  private async removeTemp(entry: Entry): Promise<void> {
    if (!entry.tempDir) return
    // best-effort：Windows 上编辑器还占着句柄时目录删不掉，留着比抛错好；
    // maxRetries 让残留句柄/杀软扫描那一档能再试两次（理由见 purgeIfOwnerGone）
    await fs.rm(entry.tempDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }

  private async launch(entry: Entry): Promise<void> {
    try {
      await this.deps.openEditor(entry.info.localPath)
    } catch (err) {
      log.warn(`launch editor failed: ${message(err)}`)
      /**
       * 编辑器起不来不该让整条编辑失败：文件已经落地、watcher 还在盯着，
       * 用户自己去打开那个文件照样能存回远端。但**只写日志是不够的** ——
       * 界面收不到任何东西，用户看到的仍是"已开始编辑"，会以为设置里那个编辑器生效了。
       * 而最常见的成因恰恰是那个 exe 在用之前的校验没过（被换掉、被删掉、导入的配置里
       * 塞了个坏值，见 launchEditor），那句人话必须摆到界面上。
       *
       * 只挂 message、不改状态：编辑本身没坏，打成 error 会让界面给出"重试写回"
       * 这种毫不相干的出口。已经带着 message 的状态（conflict/blocked/shrink/error 那句
       * 用户要看的裁决说明）不许被顶掉 —— 那只可能发生在"重复打开一条已经停下来的编辑"时，
       * 那种情况留在日志里就够了。
       */
      if (entry.closed || entry.info.message !== undefined) return
      this.setState(
        entry,
        entry.info.state,
        `外部编辑器没能启动：${message(err)}。文件已下载到本机，可手动打开：${entry.info.localPath}`
      )
    }
  }

  private setState(entry: Entry, state: RemoteEditState, msg?: string): void {
    entry.info.state = state
    entry.info.message = msg
    this.publish(entry)
  }

  private publish(entry: Entry): void {
    /**
     * 已结束的编辑只许再发那条 closed。停止编辑时可能正有一次写回在飞，
     * 它跑完后的 editing 事件会让界面凭空复活一行 —— 而那条编辑的临时文件都已经删了。
     */
    if (entry.closed && entry.info.state !== 'closed') return
    const snapshot: RemoteEditInfo = { ...entry.info }
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // 订阅方（转发到渲染进程那一层）抛错不能把状态机带走
      }
    }
  }
}

// ---------------- 本地落地 ----------------

/**
 * 排他创建本地副本，0o600。
 *
 * 为什么不用普通的 writeFile（默认 'w'）：'w' 跟随符号链接，而 mode 只在**创建**时生效 ——
 * 落到一个已存在的目标上，内容照写、权限却是那个目标原来的（比如 0644 全局可读），
 * 而这里写的是远端文件的明文副本（可能是 /etc/shadow）。'wx' 让"新建"成为唯一可能。
 *
 * 撞上已存在项时先 unlink 再建，这一手在这里是安全的：目录是本进程刚 mkdtemp 出来的私有目录
 * （0700、名字不可预测，见 TEMP_ROOT_PREFIX），里面唯一可能已经存在的东西就是同一条编辑
 * 上一次落地的那份副本，不存在"删掉别人的文件"或者"被人抢在中间摆一个软链"的问题。
 * 换在别人能写的目录里，unlink 再建就是把 EXCL 挡住的竞态窗口重新开出来 —— 别照抄这一段。
 */
async function writeExclusive(file: string, buf: Buffer): Promise<void> {
  try {
    await fs.writeFile(file, buf, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    await fs.unlink(file)
    await fs.writeFile(file, buf, { mode: 0o600, flag: 'wx' })
  }
}

// ---------------- 截断判据 ----------------

/**
 * 这次存盘像不像"只写了一半"。判据两条与为什么见 SHRINK_BASELINE_FLOOR_BYTES。
 *
 * baseline 为 0 一律放行：新建出来的空文件本来就没有内容可丢，误拦掉的话
 * "新建文件 → 写内容 → 保存"这条最常见的路第一次存盘就要用户点一次确认。
 * 拿 baseline.size（远端当前内容的长度）比，不是拿本地上一次的长度 ——
 * 闸门要挡的是"远端那份东西会不会被一份半截内容替换掉"。
 */
function looksTruncated(baselineSize: number, nextSize: number): boolean {
  if (baselineSize === 0) return false
  if (nextSize === 0) return true
  // 乘法而不是除法：整数比较，不必操心 0 除与浮点误差
  return (
    baselineSize >= SHRINK_BASELINE_FLOOR_BYTES && nextSize * SHRINK_RATIO_DIVISOR < baselineSize
  )
}

// ---------------- 临时根的归属 ----------------

/**
 * 清掉一个**已经没有主**的临时根。
 *
 * 靠进程归属判活、不靠名字：名字只能认出"这是不是我自己的根"，认不出"这是不是**另一个
 * 还活着的实例**的根"。同账号下第二个实例是真会有的（--user-data-dir、改过 app name 的
 * 开发运行都绕开单实例锁），按名字判就会在它启动时把第一个实例**正在编辑的**目录整棵删掉：
 * 用户还没存的改动静默消失，watcher 耗完重试预算放手，界面却仍然显示 editing。
 *
 * maxRetries 不是洁癖：Windows 上杀软扫描/残留句柄会让 unlink 报 EPERM/EBUSY，
 * 默认 maxRetries=0 当场抛错、被下面这个 catch 吞掉，那份**远端文件的明文副本**
 * （可能就是 /etc/shadow）于是永久留在盘上 —— 而这个函数存在的全部理由就是清掉它。
 */
async function purgeIfOwnerGone(dir: string): Promise<void> {
  if (await ownerAlive(dir)) return
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

/**
 * 这个临时根还归一个活着的进程吗？
 *
 * `process.kill(pid, 0)` 不发信号，只做"进程存在 + 我有权限给它发信号"的检查。
 * **EPERM 也算活着** —— 那说明进程确实存在，只是不归当前用户（或 pid 被别人复用了）；
 * 那种情况下删掉同样是错的，宁可多留一份明文副本也不能删活人正在编辑的东西。
 *
 * 反过来读不到 pid（旧版本留下的根、写 pid 那一下失败过、被别的清理程序动过）一律按
 * **陈旧**处理：这个函数存在的全部理由就是清掉远端文件的明文副本，无从证明它有主就该清掉 ——
 * 反了的话（读不到就跳过）等于给"删不掉的垃圾"开了一条永久豁免，明文副本从此赖在盘上。
 */
async function ownerAlive(dir: string): Promise<boolean> {
  const raw = await fs.readFile(join(dir, TEMP_OWNER_FILE), 'utf8').catch(() => null)
  const pid = raw === null ? Number.NaN : Number.parseInt(raw.trim(), 10)
  // pid ≤ 0 必须在这里挡掉：kill(0, sig) 是"发给整个进程组"、负数是"发给某个进程组"，
  // 拿一个坏 pid 文件去探活会问出个毫不相干的答案（当前进程组当然活着 → 永远不清）
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ---------------- 远端命名 ----------------

/**
 * 把内容写到目标同目录下的隐藏临时名，**排他创建**，撞名就换一个新随机名重试。
 *
 * 'wx'（CREAT|EXCL）这一条是安全要求，不是洁癖：临时名的格式是公开的、目录常常是别人
 * 也能写的（/tmp、/var/www、共享的配置目录），而写入方常常是 root、内容常常是特权文件。
 * 用 'w' 的话，别人只要先在我们即将使用的名字上摆一个符号链接，这次写入就顺着链接
 * 落到他选的路径上去了（open 跟随符号链接，先 stat 再建挡不住竞态）。
 *
 * 撞名一律换名重试，**绝不 unlink 掉再用 'w' 建** —— 那既可能删掉别人的文件，
 * 也把 EXCL 刚挡住的窗口重新开了一遍。全部尝试都失败时抛一句人话：
 * SFTP v3 没有 EEXIST，服务器对 EXCL 冲突和"目录不可写"一律回 SSH_FX_FAILURE，
 * 底层那句 "Failure" 摆给用户看等于什么都没说。
 */
async function writeRemoteTemp(
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
  throw new Error(
    `远端临时文件建不起来（在 ${remoteDirname(target)} 下试了 ${REMOTE_TEMP_ATTEMPTS} 个随机名，` +
      `可能是目录不可写或磁盘满）：${message(last)}`
  )
}

/**
 * 与目标同目录的隐藏临时名：`.<name>.ofsedit-<8hex>`。
 * 随机后缀而不是确定性后缀：万一上次进程崩在写临时文件之后，确定性名字会让这次直接
 * 截断（'w'）别人的残留文件，随机名各自独立。
 * 单段名长度按 255 字节收口 —— 远端 basename 本来就可能贴着上限，加了前缀会 ENAMETOOLONG。
 */
function siblingTempPath(target: string, tag: string): string {
  const dir = remoteDirname(target)
  const suffix = `${tag}${randomBytes(4).toString('hex')}`
  let stem = remoteBasename(target)
  while (stem.length > 1 && Buffer.byteLength(`.${stem}${suffix}`) > MAX_REMOTE_NAME_BYTES) {
    stem = stem.slice(0, -1)
  }
  return remoteJoin(dir, `.${stem}${suffix}`)
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
async function degradedReplace(
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------- 默认实现（接线用） ----------------

/**
 * launchEditor 的三个可替换动作。**只为单测**：它们分别是"用之前的校验"、"真的起进程"、
 * "交给系统默认打开方式"，三者在单测里都不能真的发生（不许弹记事本、不许起进程），
 * 而"校验没过时一次都没 spawn、也没偷偷退化成系统默认打开"这两条恰恰是护栏要钉的东西。
 * 生产路径一个都不传，走下面那三个默认实现。
 */
export interface LaunchEditorHooks {
  /** spawn 之前的用时校验，默认 services/settings 的 assertUsableEditor */
  assertUsable: (exePath: string) => Promise<void>
  /** 真的起进程的那一下 */
  spawnEditor: (exePath: string, args: string[]) => void
  /** 没配 exe 时的系统默认打开方式 */
  openWithSystem: (absPath: string) => Promise<void>
}

/**
 * 起外部编辑器。
 *
 * 三条红线：
 * 1. 绝不走 shell、绝不拼命令行字符串（shell: false + 参数数组），设置里也只接受一个 exe
 *    的绝对路径、不接受参数模板 —— 从根上消除命令注入，不必去猜哪种引号在 cmd.exe 下安全。
 * 2. detached + unref：编辑器是用户的长期进程，不能挂在 Electron 的进程树上被一起带走
 *    （用户关掉主窗口时正编辑到一半的 vscode 不该跟着没）。stdio 'ignore' 免得管道满了阻塞。
 * 3. **spawn 之前再校验一次那个 exe**（assertUsableEditor）。写入侧的校验（sftp:pickEditor）
 *    管不到已经躺在库里的值：老版本写下的、导入的配置文件带来的、有人手改 SQLite 的，
 *    全都绕过它 —— 而这里 spawn 的是**可执行文件本身**，不是参数。
 *    刻意每次都校验、不在外面攒"校验过了"的标记：exe 完全可以在两次存盘之间被换掉，
 *    那正是攻击者要做的事。
 *    校验不过就**抛错，绝不静默退化成系统默认打开** —— 退化会让用户以为编辑器配置生效了；
 *    错误由 RemoteEditManager.launch 转成一条界面看得见的 message。
 *
 * 没配 exe（空串）时退化到 shell.openPath（系统默认打开），且这条路**不调校验**：
 * '' 在 assertUsableEditor 眼里是"非绝对路径"会被拒，而 '' 在本项目里是合法语义
 * （"系统默认打开方式"），所以必须先判空再调。
 * shell.openPath 在这里唯一的安全依据是：**被打开的路径不可能来自渲染进程** —— 全是 main 侧
 * 从 (sessionId, remotePath) 派生出来的临时路径，任何 IPC 接口都不接受本地路径。
 * 哪天有人给编辑相关的 IPC 加上"本地路径"参数，这一行就立刻变成任意文件打开。
 */
export async function launchEditor(
  absPath: string,
  exePath: string,
  hooks: Partial<LaunchEditorHooks> = {}
): Promise<void> {
  if (!exePath) {
    await (hooks.openWithSystem ?? openWithSystemDefault)(absPath)
    return
  }
  await (hooks.assertUsable ?? assertUsableEditorLazy)(exePath)
  ;(hooks.spawnEditor ?? spawnEditorDetached)(exePath, [absPath])
}

async function openWithSystemDefault(absPath: string): Promise<void> {
  const err = await shell.openPath(absPath)
  // openPath 不抛，它把失败原因放在返回值里（空串 = 成功）
  if (err) throw new Error(`打开文件失败：${err}`)
}

function spawnEditorDetached(exePath: string, args: string[]): void {
  const child = spawn(exePath, args, { shell: false, detached: true, stdio: 'ignore' })
  // 这条只剩"校验过了但起进程仍然失败"的残余情况（exe 刚好在校验之后被换/被删）：
  // 事件是异步来的，launchEditor 早就 resolve 了，没处可报，只能记日志
  child.on('error', (err) => log.warn(`editor spawn error: ${err.message}`))
  child.unref()
}

/** 默认校验。动态 import 的理由与 defaultDeps 里那次相同：settings 那条链会把 store/Database 拖进单测 */
async function assertUsableEditorLazy(exePath: string): Promise<void> {
  const { assertUsableEditor } = await import('../services/settings')
  await assertUsableEditor(exePath)
}

/**
 * 默认依赖。sshManager 与 settings 用**动态** import 拿，不是随手写的：
 * - sshManager 静态 import 会成环 —— 会话关闭时 SshConnectionManager 要回头调
 *   stopBySession，于是 sshManager → RemoteEditManager → sshManager，
 *   ESM 循环下模块初始化期取到的 `sshManager` 可能还是 undefined；
 * - settings 那条链（store/Database）导入即建库，单测不该被它拖进来。
 * electron 反倒可以静态 import：vitest 侧有 test/stubs/electron.ts 顶着。
 */
function defaultDeps(): RemoteEditDeps {
  return {
    getSftp: async (sessionId) => {
      const { sshManager } = await import('../ssh/SshConnectionManager')
      // 走主连接上常驻的浏览用 SFTP，不为编辑一个小文件另拨一条连接
      return sshManager.get(sessionId).browseSftpSession()
    },
    openEditor: async (absPath) => {
      const { getSettings, assertUsableEditor } = await import('../services/settings')
      /**
       * externalEditorPath 早就进了 AppSettings.sftp，所以这里**直接用类型**，
       * 不再 `as unknown as { externalEditorPath?: string }` —— 那层 cast 当初是为了
       * 不跟并行改动的类型文件互锁，字段落地之后它剩下的唯一作用就是关掉类型检查：
       * 谁把字段改个名，tsc 一声不响，运行时取到 undefined，编辑器静默退化成系统默认打开。
       *
       * `?? ''` 留着不是为了绕类型：settings 是 deepMerge(defaults, 用户库) 出来的，
       * 手改过的库里这一键可能是 null/缺失，运行时兜一下比 trim 报 TypeError 好。
       */
      const { sftp } = getSettings()
      // 校验函数就手传进去：同一次动态 import 里拿到的，省掉 launchEditor 内部再 import 一次
      await launchEditor(absPath, (sftp.externalEditorPath ?? '').trim(), {
        assertUsable: assertUsableEditor
      })
    },
    tempRoot: () => app.getPath('temp'),
    watch: watchLocalFile
  }
}

export function createRemoteEditManager(
  overrides: Partial<RemoteEditDeps> = {}
): RemoteEditManager {
  return new RemoteEditManager({ ...defaultDeps(), ...overrides })
}

export const remoteEditManager = createRemoteEditManager()
