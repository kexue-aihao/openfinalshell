import {
  readFileSync,
  realpathSync,
  statSync,
  unwatchFile,
  watch,
  watchFile,
  type FSWatcher
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { sha256Hex } from './editGuards'

/**
 * 远端编辑落地文件的存盘监视。
 *
 * 为什么盯目录、不盯文件：Windows 上的编辑器几乎都不原地改写 —— VS Code、Notepad++、
 * Win11 记事本存盘都是"写一个临时文件再 MoveFileEx 覆盖目标"。盯着文件本身的
 * 句柄/inode，rename 覆盖之后 watcher 指的还是被替换掉的那个旧文件，用户明明按了
 * Ctrl+S，我们一个事件都收不到。所以约定：每个编辑独占一个临时目录、目录里只放那
 * 一个文件（由 editGuards 的 tempRelPath 保证），这里 watch 目录，兄弟噪音按名字挡掉。
 *
 * 为什么只信内容哈希：事件类型和 mtime 都不可信 —— Defender 扫完会回写、编辑器会
 * 单独 touch 时间戳、我们自己下载落地那一次写入本身也会触发。唯一可靠的判据是
 * "内容 sha256 与上一次已知内容不同"，这一条把绝大多数假阳性直接挡在门外。
 * "写完了没有"同样只信内容：连续两次读到同样的字节才算这次存盘落定
 * （为什么不能信 size/mtime，见 DEFAULT_CONFIRM_INTERVAL_MS）。
 *
 * 这里不套 remotePath.longPath 的 \\?\ 前缀：ReadDirectoryChangesW 对该前缀的行为
 * 没把握，而临时目录是我们自己在 tmp 下建的，长度本来就不会顶到 MAX_PATH。
 */

export interface WatchHandle {
  close(): void
}

export interface WatchOptions {
  /** 轮询兜底间隔；fs.watch 在网络盘/某些 FS 上不可靠 */
  pollIntervalMs?: number
  /** 连写合并窗口 */
  debounceMs?: number
  /** 内容确认间隔：读到一份新内容后隔这么久重读一次，两次一样才算写完 */
  confirmIntervalMs?: number
}

/**
 * 180ms：一次存盘在 Windows 上通常是"临时文件写入 + rename + 属性回写"三四个事件，
 * 实测挤在 100ms 以内。150ms 偶尔会被 Defender 拖慢的 rename 切成两半（同一次存盘
 * 回调两次、白上传一遍）；250ms 往上用户能感觉到"存完了半天没动静"。取中间值。
 */
const DEFAULT_DEBOUNCE_MS = 180

/**
 * 1s：fs.watch 正常工作时这条轮询永远不会先到，它只在网络盘、容器 bind mount、
 * 某些 FUSE 上顶上来。再密就是白烧 stat（每个打开的编辑一个 StatWatcher）。
 */
const DEFAULT_POLL_INTERVAL_MS = 1000

/**
 * 读文件的重试预算 40ms × 15 ≈ 600ms。rename 覆盖的那一瞬间目标可能不存在，
 * 杀毒软件/编辑器也可能短暂独占句柄 —— 这些都不是错误，等一下就好了。
 * 预算有限是为了不把"文件真的没了"拖成无限重试。
 */
const READ_RETRY_DELAY_MS = 40
const READ_RETRY_LIMIT = 15

/**
 * 250ms：内容确认间隔 —— 读到一份新内容后要再等这么久重读一次，两次字节一样才算写完。
 *
 * 为什么非要这一步：有一类编辑器是**原地分段改写** —— open 'w' 截断 → 写前半 →
 * 停顿 → 写后半 → close（vim backupcopy=yes、PowerShell Set-Content、部分
 * Java/Delphi 编辑器都走这条路）。那个停顿一旦跨过防抖窗口，"前后各 stat 一次"
 * 就完全失效：那一刻写者确实没在写，两次 stat 的 size 一致，NTFS 对持有句柄的文件
 * 连 last-write-time 都懒更新、mtimeMs 也一致 —— 于是半个文件被判成一次存盘，
 * 原子替换到远端，正在 `nginx -s reload` 的服务读到的就是残缺配置。
 *
 * 取值：必须明显大于防抖窗口（180ms），才盖得住"两段写之间的停顿"这个量级 ——
 * 危险的停顿恰好就在防抖这条线上下，比它短的停顿本来就被防抖合并掉了。
 * 又不能更大：一次存盘只多付一次这个钱（180+250 ≈ 0.4s 从松手到开始上传），
 * 再往上用户就开始觉得"存完了半天没动静"。
 */
const DEFAULT_CONFIRM_INTERVAL_MS = 250

/**
 * 确认轮次上限。被持续追加写的文件（`tail -f` 式的日志、编辑器每隔几百毫秒打一次
 * 自动保存）两次读永远不会一样，没有上限就是无限等下去、这次存盘永远不上传。
 * 4 轮 ≈ 1s 之后放手，等下一个事件重新开始 ——
 * 宁可漏这一次，也不能把半截内容当存盘上传去覆盖服务器。
 */
const CONFIRM_LIMIT = 4

/** fs.watch 挂掉后的自愈重挂：目录被整体替换时会连环报错，不设上限会烧成忙循环 */
const REWATCH_DELAY_MS = 200
const MAX_REWATCH = 10

/** 这些 errno 一律当成"再等等"，而不是"读失败了" */
const TRANSIENT_READ_ERRORS = new Set(['ENOENT', 'EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'EAGAIN'])

/**
 * 兄弟噪音：目录里除了目标文件，编辑器还会顺手造出这些东西。
 * 它们照样触发目录事件，但重读目标的哈希不会变，所以挡不住也不会误报 ——
 * 挡掉是为了省掉一次读、更重要的是别让噪音不停地把防抖窗口往后推，
 * 把一次存盘的回调拖成"编辑器一直在写临时文件所以永远不上传"。
 */
const NOISE_NAMES: RegExp[] = [
  /~$/, // 编辑器备份：nginx.conf~
  /^4913$/, // vim 开工前写来试目录可写性的探测文件，名字是固定的
  /^\..*\.swp$/, // vim 交换文件 .nginx.conf.swp
  /\.tmp/, // VS Code / JetBrains 的落地临时名：x.tmp、x.tmp-abc
  /^~\$/ // Office 锁文件 ~$doc.docx
]

/**
 * 从 editGuards 转口。本模块以前自己实现过一份逐字节相同的 sha256Hex，
 * RemoteEditManager 一直是从这里 import 的 —— 实现合并到 editGuards（那边的注释
 * 描述的本来就是"上传前后比对内容"这件事），导出面保持不变，免得动别人的文件。
 */
export { sha256Hex }

function isNoiseName(name: string): boolean {
  return NOISE_NAMES.some((re) => re.test(name))
}

type ReadAttempt = { ok: true; buf: Buffer } | { ok: false; retry: boolean }

export function watchLocalFile(
  filePath: string,
  initialSha256: string,
  onChanged: (buf: Buffer, sha256: string) => void,
  opts?: WatchOptions
): WatchHandle {
  const dir = dirname(filePath)
  const targetName = basename(filePath)
  const debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const confirmIntervalMs = opts?.confirmIntervalMs ?? DEFAULT_CONFIRM_INTERVAL_MS

  let knownSha = initialSha256
  let closed = false
  let watcher: FSWatcher | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  // 读重试与内容确认共用这一条在途定时器：两者都是"同一次存盘还没读定"的等待，
  // 新事件到了必须一起作废
  let readTimer: ReturnType<typeof setTimeout> | null = null
  let rewatchTimer: ReturnType<typeof setTimeout> | null = null
  let rewatchLeft = MAX_REWATCH

  /**
   * 只读目标文件，读到一半的写入要能识别出来。
   *
   * 前后各 stat 一次是便宜的第一道筛：写入正在进行时 size/mtime 还在变，当场判
   * "再等等"，省掉一次哈希和一整轮确认。但它只是筛子、不是判据 —— 被防抖窗口
   * 切开的原地分段改写它一点都看不出来（那一刻两次 stat 完全一致，
   * 见 DEFAULT_CONFIRM_INTERVAL_MS），真正判"写完了"的是 attempt 里那条
   * "连续两次读到同样的内容"。编辑器走"写临时文件再 rename 覆盖"那条路时
   * rename 本身是原子的，这两道都不会被绊到，第一次确认就能通过。
   */
  function readStable(): ReadAttempt {
    try {
      const before = statSync(filePath)
      const buf = readFileSync(filePath)
      const after = statSync(filePath)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        return { ok: false, retry: true }
      }
      return { ok: true, buf }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      return { ok: false, retry: Boolean(code && TRANSIENT_READ_ERRORS.has(code)) }
    }
  }

  /**
   * 一次存盘的读取流水线。三个入参里两个是预算，都必须有上限：
   * - tries：文件暂时读不到（rename 中途、杀毒短暂独占句柄）的重试预算；
   * - confirms：读到了、但两次读到的内容还不一致时的确认预算；
   * - pendingSha：上一轮读到的内容哈希，这一轮读到的和它一样才算这次存盘落定。
   */
  function attempt(tries: number, confirms: number, pendingSha: string | null): void {
    if (closed) return
    const got = readStable()
    if (!got.ok) {
      // 不可重试的错（比如目标变成了目录）就地放手，等下一个事件再说；
      // 预算烧完也放手 —— 宁可漏这一次，也不能把半截内容当存盘上传去覆盖服务器
      if (!got.retry || tries >= READ_RETRY_LIMIT) return
      readTimer = setTimeout(() => {
        readTimer = null
        // 候选照原样带下去：这一轮只是没读到，不是读到了别的内容
        attempt(tries + 1, confirms, pendingSha)
      }, READ_RETRY_DELAY_MS)
      return
    }
    const sha = sha256Hex(got.buf)
    if (sha === knownSha) return
    if (sha !== pendingSha) {
      // 第一次读到这份内容，或者两次读到的不一样（写者还在分段写）：
      // 把这一次当新的起点再确认一轮。确认预算烧完就放手，等下一个事件。
      // 注意这里**不能**推进 knownSha —— 没确认成功的读一旦被记成"已知内容"，
      // 用户就得再改一次内容才能存得进去（同样的字节存第二遍会被当噪音挡掉）。
      if (confirms >= CONFIRM_LIMIT) return
      readTimer = setTimeout(() => {
        readTimer = null
        attempt(tries, confirms + 1, sha)
      }, confirmIntervalMs)
      return
    }
    // 连续两次读到同样的内容 → 这次存盘真的写完了，到这一步才推进 knownSha
    knownSha = sha
    // 事件确实到了，说明这条 watcher 是活的，把自愈额度还回去
    rewatchLeft = MAX_REWATCH
    try {
      onChanged(got.buf, sha)
    } catch {
      // 消费方抛错不能把 watcher 带走，否则用户后面每一次存盘都静默丢失
    }
  }

  /** 任一条路（目录事件 / 轮询）触发都进这条流水线，靠哈希去重，所以两条一起上是安全的 */
  function arm(): void {
    if (closed) return
    // 新事件到了就作废在途的重试/确认：窗口里读到的必须是最后一次写入的内容，
    // 在途那个候选哈希已经过期了，两个预算一起从头算
    if (readTimer) {
      clearTimeout(readTimer)
      readTimer = null
    }
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      attempt(0, 0, null)
    }, debounceMs)
  }

  /**
   * 目标名优先判：万一用户编辑的文件本身就叫 x.tmp，噪音名单不能把它自己挡掉。
   * filename 为 null（部分平台/FS 给不出名字）时不敢丢事件，一律进流水线让哈希去判；
   * 名字既不是目标也不像噪音的，同样放进去 —— 多读一次的代价远小于漏一次存盘。
   * 反过来，rename 覆盖时有的平台只报得出**源**的临时名（会被当噪音挡掉），
   * 这种情况靠 watchFile 那条轮询兜住 —— 最坏是晚一个轮询周期，不会丢。
   */
  function onDirEvent(name: string | null): void {
    if (closed) return
    if (name !== null && name !== targetName && isNoiseName(name)) return
    arm()
  }

  /**
   * fs.watch 之前必须把目录解析成真实长路径，这条是血的教训。
   * Windows 上 %TEMP% 常常是 8.3 短名（实测本机就是
   * `C:\Users\ADMINI~1\AppData\Local\Temp`，app.getPath('temp') 同样如此），
   * 而 ReadDirectoryChangesW 回来的是长名，libuv 的 fs-event.c 里那句
   * `assert(!_wcsnicmp(filename, dir, dirlen))` 当场失败 —— 那是 abort，
   * 不是能 try/catch 的异常，整个主进程直接没了，用户看到的是"存盘时软件闪退"。
   * 注意 realpathSync 不解短名，只有 .native 走 GetFinalPathNameByHandle 才行。
   * 所以：解析不出长路径就干脆不挂目录 watcher，退化成纯轮询 ——
   * 慢一个周期可以接受，把主进程 abort 掉不可以。
   */
  function resolveWatchDir(): string | null {
    try {
      return realpathSync.native(dir)
    } catch {
      return null
    }
  }

  function attach(): void {
    if (closed) return
    const real = resolveWatchDir()
    if (real === null) return
    try {
      const next = watch(real, { persistent: true }, (_event, name) => onDirEvent(name))
      // 目录被替换/删除时 fs.watch 会报错并从此收不到任何事件，必须重挂
      next.on('error', () => reattach())
      watcher = next
    } catch {
      reattach()
    }
  }

  function reattach(): void {
    if (closed) return
    try {
      watcher?.close()
    } catch {
      // 已经死掉的 watcher 再 close 会抛，无所谓
    }
    watcher = null
    // 额度烧完就退化成纯轮询：慢一个周期，但比彻底瞎掉好
    if (rewatchLeft <= 0) return
    rewatchLeft -= 1
    if (rewatchTimer) clearTimeout(rewatchTimer)
    rewatchTimer = setTimeout(() => {
      rewatchTimer = null
      attach()
    }, REWATCH_DELAY_MS)
  }

  const onPoll = (): void => arm()

  attach()
  watchFile(filePath, { persistent: true, interval: pollIntervalMs }, onPoll)

  return {
    close(): void {
      closed = true
      try {
        watcher?.close()
      } catch {
        // 同上
      }
      watcher = null
      unwatchFile(filePath, onPoll)
      if (debounceTimer) clearTimeout(debounceTimer)
      if (readTimer) clearTimeout(readTimer)
      if (rewatchTimer) clearTimeout(rewatchTimer)
      debounceTimer = null
      readTimer = null
      rewatchTimer = null
    }
  }
}
