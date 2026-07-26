import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('local-tar')

/**
 * 本地 tar 的调用与归档校验。**全项目唯一使用 `child_process` 的地方** ——
 * 在这个文件出现之前 `src/main` 一处都没起过子进程，评审时这条要单独看。
 *
 * 三条铁律：
 *  - `spawn(exe, argv, { shell: false })`，**永不**传命令串、永不 `exec`、
 *    永不 `windowsVerbatimArguments`。每个路径是独立的 argv 项，所以**本地这一侧
 *    根本没有 shell，`shQuote` 不参与**。
 *  - tar 的可执行文件用**绝对路径**定位，绝不走 PATH（见 findLocalTar）。
 *  - 解包之前先把归档里的成员名单**全部**过一遍（checkTarEntries），不通过就不解。
 */

/** stdout 上限。`tar -tf` 一个十万文件的包约 6MB；超过这个数说明事情不对，宁可降级 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** 输出超上限被掐掉（此时校验必然不完整，调用方必须当失败处理） */
  overflow: boolean
  timedOut: boolean
}

/**
 * `encoding` 只有 list 用得上，用 `latin1`。
 *
 * 实测（Win10 19045，CP936）：`tar -tf` 把成员名按**系统 ANSI 代码页**写到 stdout ——
 * `日志-火.log` 出来的是 GBK 字节，`🔥` 直接变成 `?`。也就是说**列出来的名字读不懂**，
 * 这一条决定了 checkTarEntries 只能依赖 ASCII 字节做判断（见那边的说明）。
 *
 * latin1 与 utf8 在**安全性上没有区别**（两者都保留 ASCII 字节，而所有检查只看 ASCII）；
 * 选 latin1 的理由是它"字节对字符"无损，于是拒绝时打出来的那串名字还认得出是什么，
 * 而 utf8 会把它糊成一片 U+FFFD。别把这一行当成一道防线。
 *
 * （解包**不受**这个影响：libarchive 从归档字节直接转 UTF-16 写 NTFS，落地的名字是对的。
 *   实测解出来的就是正确的 `日志-火.log`。问题只在"列出来给我们看"这一步。）
 */
function run(
  exe: string,
  args: string[],
  timeoutMs: number,
  encoding: 'utf8' | 'latin1' = 'utf8'
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    // shell: false 是默认值，写出来是为了让"这里绝不过 shell"在代码上可见
    const child = spawn(exe, args, { shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let overflow = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length > MAX_OUTPUT_BYTES) {
        overflow = true
        return
      }
      stdout += chunk.toString(encoding)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, overflow, timedOut })
    })
  })
}

/**
 * 找本机的 tar。**绝不走 PATH。**
 *
 * 这条在开发机上就能演示：
 * ```
 * where tar → C:\Program Files\Git\usr\bin\tar.exe   (GNU tar 1.35, MSYS —— 会做路径转换)
 *             C:\Windows\System32\tar.exe            (bsdtar 3.8.4 —— 我们要的那个)
 * ```
 * PATH 命中的是前者，而 MSYS 那个会把 `C:\x` 当成选项/做路径改写，行为完全不同。
 *
 * 32 位产物的坑：本项目发 ia32，而 32 位进程访问 `System32` 会被 WOW64 重定向到
 * `SysWOW64`。实测 Win10 19045 的 SysWOW64 里确实也有一份 tar.exe，所以正常路径够用；
 * `Sysnative`（只有 32 位进程看得见的真 System32）作为兜底，免得撞上没铺 WOW64 副本的版本。
 */
export function findLocalTar(): string | null {
  if (process.platform !== 'win32') {
    return ['/usr/bin/tar', '/bin/tar'].find((p) => existsSync(p)) ?? null
  }
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return [join(root, 'System32', 'tar.exe'), join(root, 'Sysnative', 'tar.exe')].find((p) =>
    existsSync(p)
  ) ?? null
}

// ---------------------------------------------------------------------------
// 归档成员校验
// ---------------------------------------------------------------------------

export interface TarEntryCheck {
  /** 越界类：绝对路径、盘符、`..`、不在唯一顶层之下、空归档。**有一条就不许解包** */
  unsafe: string[]
}

/**
 * 解包前的成员名单校验。**纯函数。**
 *
 * 这一遍顺序扫描买到两样东西：
 *  1. **路径安全**：libarchive 不传 `-P` 时自己也会剥前导 `/`、把 `\` 归一成分隔符、
 *     并拒掉任何拼法的 `..`（实测：`app/..\..\evil.txt` 被它报
 *     `Path contains '..'` 并以非 0 退出，evil.txt 哪儿都没落）。但"文档说默认是安全的"
 *     不能是唯一防线 —— 项目当初把压缩/解压推到 v1.5 就是因为这个。
 *  2. **完整性**：`tar -tf` 走完整个归档，于是**在动用户目录之前**就知道包是不是坏的。
 *     实测截断的包退非 0（"Unrecognized archive format" / "Truncated input file"）。
 *     ⚠️ 但 **0 字节文件 `tar -tf` 退 0 且没有任何输出**，所以空名单必须当越界处理 ——
 *     否则一次失败的下载会被报成"解包成功"。
 *
 * **刻意不检查"名字在 Windows 上是否合法"**，这一条与计划里写的不一样，理由是实测结果：
 * bsdtar 解包时对这类名字**既不报错也不失败，而是自己就地改名**
 * （`app/a:b.txt` → `a_b.txt`，`con` 与 `trailing.` 原样落地，rc=0、stderr 一个字都没有）。
 * 也就是说根本没有"白费一次下载"这回事，而 `a:b` → `a_b` 恰好与逐文件那条路上
 * sanitizeLocalName 的结果一致。加这条检查只会带来两个坏处：
 * 一是无用的降级，二是它**必然误判** —— 见下面关于编码的那段。
 *
 * ### 为什么每条检查都只碰 ASCII
 *
 * 传进来的名字是 `latin1` 解出来的**字节序列**，不是可读文本：Windows 上 `tar -tf`
 * 按系统 ANSI 代码页（本机 CP936）输出，中文是 GBK 字节、emoji 直接变 `?`。
 * 所以任何"看得懂名字"的检查在这里都是不可靠的。而下面这些检查是可靠的：
 *  - `.`（0x2E）与 `/`（0x2F）**不可能**是 CP936/Shift-JIS 这类代码页的多字节组成部分
 *    （首字节 0x81–0xFE、尾字节 0x40–0xFE），所以字节流里出现的 `..` 与 `/` 一定是真的；
 *  - 顶层名由我们自己指定，且只在它是纯 ASCII 时才有意义（远端目录名非 ASCII 时
 *    shouldPack 会拒绝打包，见 packTransfer）；
 *  - 反斜杠（0x5C）**可能**是 GBK 尾字节，所以不单独拒 `\` —— 只把它当分隔符参与
 *    `..` 检查。误判方向也是安全的：多切一刀只可能多出一个无害的段。
 *
 * ### 顶层项：先按"只能有一个"判，名字只在能比的时候才比
 *
 * 我们只打整目录，所以归档里恰好一个顶层项 —— 这正是"顶层检查"能写成一行的原因。
 * 但**按名字**比会踩上面那条编码问题：远端目录叫 `中文` 时，归档里存的是 UTF-8 字节、
 * `tar -tf` 吐的是 CP936 字节，与 JS 里那个 UTF-8 字符串怎么都对不上 ——
 * 于是**每一条成员都会被判越界**，一个中文目录名就让整个功能关门。
 *
 * 所以主判据是**"所有成员的第一段必须是同一个"**（与编码无关：比的是字节相等）。
 * 这已经足够保证"一切都落在 <目标目录>/<某个单一顶层> 之下" —— 配合绝对路径与 `..`
 * 两条检查，容器性是完整的。`expectedTop` 只在它是纯 ASCII 时额外做一次身份核对
 * （那时字节可比），算多一道保险，不是必需项。
 *
 * 名字里含换行会被 `tar -tf` 切成两行，两半的第一段互不相同 → 判越界 → 关门，方向正确。
 */
export function checkTarEntries(names: string[], expectedTop: string): TarEntryCheck {
  const unsafe: string[] = []
  if (names.length === 0) {
    unsafe.push('(归档里一个成员都没有)')
    return { unsafe }
  }
  const tops = new Set<string>()
  for (const raw of names) {
    // 目录成员带尾斜杠（bsdtar 实测 `app/`），比较前去掉；GNU tar 有时给 `./` 前缀
    const name = raw.replace(/^\.\//, '').replace(/\/+$/, '')
    if (name === '') {
      unsafe.push(raw)
      continue
    }
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      unsafe.push(raw)
      continue
    }
    // 穿越检查把反斜杠也当分隔符 —— bsdtar 实测就是这么归一的（`app/sub\x` → `app/sub/x`）
    if (name.split(/[\\/]/).some((s) => s === '..' || s === '.')) {
      unsafe.push(raw)
      continue
    }
    tops.add(name.split('/')[0])
  }
  if (unsafe.length > 0) return { unsafe }
  if (tops.size !== 1) {
    unsafe.push(`(顶层项不止一个：${[...tops].slice(0, 4).join(', ')})`)
    return { unsafe }
  }
  // 纯 ASCII 的顶层名才有得比（非 ASCII 时 list 输出的编码不是 UTF-8，见上面）
  const only = [...tops][0]
  if (!/[^\x20-\x7e]/.test(expectedTop) && only !== expectedTop) {
    unsafe.push(`(顶层项是 ${only}，期望 ${expectedTop})`)
  }
  return { unsafe }
}

// ---------------------------------------------------------------------------
// 调 tar
// ---------------------------------------------------------------------------

/** 打包/解包的超时按体积放大：一个永远不返回的子进程比一个偏松的上限更糟 */
export function tarTimeoutMs(bytes: number): number {
  return Math.max(120_000, Math.round(bytes / (5 * 1024 * 1024)) * 1000)
}

export interface ListResult {
  names: string[]
  /** tar -tf 自己退非 0 就意味着归档被截断/损坏 */
  ok: boolean
  stderr: string
}

export async function listTarEntries(
  tarPath: string,
  archive: string,
  timeoutMs: number
): Promise<ListResult> {
  // latin1 = 字节对字符的无损解码。**不要改成 utf8** —— 见 run() 上面那段实测说明
  const r = await run(tarPath, ['-tf', archive], timeoutMs, 'latin1')
  if (r.overflow) {
    return { names: [], ok: false, stderr: '归档成员过多，无法完整校验（已放弃解包）' }
  }
  const names = r.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '')
  return { names, ok: r.code === 0 && !r.timedOut, stderr: r.stderr }
}

export interface ExtractOutcome {
  /** 全部解出来了（可能带 skippedSymlinks） */
  ok: boolean
  /** Windows 上创建软链需要特权，逐条报错但其余文件都解出来了 —— 这不算整体失败 */
  skippedSymlinks: number
  /** 认不出的 stderr 行（有这个就是硬失败） */
  fatal: string[]
  stderr: string
}

/**
 * 解包。**不传 `-p`**（实测 `-p` 是 opt-in，默认就不恢复权限；NTFS 也表达不了 POSIX mode），
 * **绝不传 `-P` / `--absolute-paths`**（不传时 libarchive 自己就剥前导 `/`、拒 `..` 与
 * 不安全的软链穿越）。
 *
 * 就地解到下载目录、不走暂存目录：每一条成员都已被证明位于唯一顶层之下，
 * 就地解包给出的正是今天逐文件下载的合并/覆盖语义，且不多占一份本地副本。
 */
export async function extractTar(
  tarPath: string,
  archive: string,
  destDir: string,
  timeoutMs: number
): Promise<ExtractOutcome> {
  const r = await run(tarPath, ['-x', '-f', archive, '-C', destDir], timeoutMs)
  const cls = classifyExtractStderr(r.stderr)
  if (r.timedOut) {
    return { ok: false, skippedSymlinks: cls.skippedSymlinks, fatal: ['解包超时'], stderr: r.stderr }
  }
  if (r.code === 0) {
    return { ok: true, skippedSymlinks: cls.skippedSymlinks, fatal: [], stderr: r.stderr }
  }
  // 非 0 不等于整体失败：Windows 上软链必然失败，但其余文件全解出来了
  const ok = cls.fatal.length === 0 && cls.skippedSymlinks > 0
  if (!ok) log.warn(`extract failed (code ${r.code}): ${cls.fatal.slice(0, 3).join(' | ')}`)
  return { ok, skippedSymlinks: cls.skippedSymlinks, fatal: cls.fatal, stderr: r.stderr }
}

/**
 * 把解包的 stderr 分成"良性"与"认不出"。纯函数。
 *
 * 为什么需要这个：Windows 上没有 `SeCreateSymbolicLinkPrivilege`（也没开开发者模式）时，
 * bsdtar 会为**每一条软链**报一行错并以非 0 退出 —— 但其余文件一个不少地解出来了。
 * 把非 0 一律当失败，会让"下载任何含软链的目录"都报错并白扔掉整个归档。
 *
 * 反过来也要守住：只有认得出的模式才算良性，出现一行认不出的就硬失败。
 * 宁可多报一次错，不能把"磁盘满了"当成"跳过了几个软链"。
 */
export function classifyExtractStderr(stderr: string): { skippedSymlinks: number; fatal: string[] } {
  let skippedSymlinks = 0
  const fatal: string[] = []
  for (const line of stderr.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    // 这一行只是"前面有错所以退非 0"的收尾，不带新信息
    if (/Error exit delayed from previous errors/i.test(text)) continue
    if (/Cannot restore (extended )?attributes/i.test(text)) continue
    if (/symlink|symbolic link|Can't create link|hard link/i.test(text)) {
      skippedSymlinks += 1
      continue
    }
    fatal.push(text)
  }
  return { skippedSymlinks, fatal }
}
