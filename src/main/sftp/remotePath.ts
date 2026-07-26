import { posix } from 'node:path'

/**
 * 远端路径域隔离：branded type 强制所有远端路径操作走本模块（内部一律 path.posix），
 * 杜绝 Windows 反斜杠混入 SFTP 请求。
 */
export type RemotePath = string & { readonly __brand: 'RemotePath' }

/** 把用户输入/服务器返回的字符串规范为 RemotePath（统一正斜杠、折叠重复分隔符） */
export function toRemotePath(input: string): RemotePath {
  const normalized = input.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const trimmed = normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized
  return (trimmed || '/') as RemotePath
}

export function remoteJoin(base: RemotePath | string, ...parts: string[]): RemotePath {
  return toRemotePath(posix.join(base, ...parts))
}

export function remoteDirname(p: RemotePath | string): RemotePath {
  return toRemotePath(posix.dirname(p))
}

export function remoteBasename(p: RemotePath | string): string {
  return posix.basename(p)
}

/** 远端路径的各级父目录，从最浅到最深（用于逐级 mkdir） */
export function remoteAncestors(p: RemotePath): RemotePath[] {
  const segments = p.split('/').filter(Boolean)
  const out: RemotePath[] = []
  let acc = p.startsWith('/') ? '' : '.'
  for (const seg of segments) {
    acc = `${acc}/${seg}`
    out.push(toRemotePath(acc))
  }
  return out
}

/** 远端路径长度上限（Linux PATH_MAX） */
const REMOTE_PATH_MAX = 4096

/**
 * 一条远端路径要进 **shell 命令**之前必须过这一关。走 SFTP 协议的那些操作不需要
 * （那边路径是独立字段、不经任何解释器），这个函数是给 `sh -c` 那条路准备的。
 *
 * ⚠️ 别指望 toRemotePath 兜住这些：它只做归一化 —— `toRemotePath('-rf')` 原样返回
 * `-rf`，既不强制绝对路径也不剥 `..`。守卫必须是**另一个**显式的函数。
 *
 * **拒绝而不是规范化**。事后审计"我拒掉的就是你给的那条"远比"我悄悄改写过、
 * 改完之后到底删了哪个目录"容易；而这个函数的下游是 `rm -rf`。
 *
 * 逐条为什么：
 *  - **空 / 纯空白**：`rm -rf -- ''` 在某些 shell 里等价于 `rm -rf -- .`，且空串一定是上游 bug。
 *  - **NUL / LF / CR**：NUL 根本传不过去（见 shQuote）；换行与回车在单引号里是**合法**的，
 *    真正的问题是我们按行解析命令输出（`OFSLEFT:%s\n`），一个含换行的名字会被切成两行 ——
 *    于是"哪几条没删掉"就成了错的。这是**协议**约束，所以拦在这里而不是 shQuote 里。
 *  - **超长**：远端会自己报 ENAMETOOLONG，但那要等一个往返，而且 4096 也是我们发出去的
 *    命令长度预算的基础。
 *  - **必须绝对路径**：相对路径的含义取决于 `sh -c` 的工作目录（是登录目录，不是用户在
 *    面板里看的那个 cwd）。顺带这一条也挡掉了 `-rf`、`--no-preserve-root` 这类
 *    "看起来像路径的选项"（它们不以 `/` 开头）—— 但那只是**副作用**，构造器里的 `--` 才是正解。
 *  - **段里不许有 `.` / `..`**：`/data/app/../../etc` 指向 `/etc`，而任何基于前缀或层级的
 *    判断（快速删除的深度规则、打包时的顶层前缀检查）都会被它绕过。
 *
 * 刻意**不**拒通配元字符：真实文件名里可以有 `*`、`?`、`[`，而我们全程单引号包着、
 * 它们就是字面量。拒掉只会让用户删不掉自己的文件。
 */
export function assertSafeRemotePath(p: string, what = '远端路径'): RemotePath {
  if (p.trim() === '') throw new Error(`${what}不能为空`)
  if (/[\0\n\r]/.test(p)) throw new Error(`${what}含换行或 NUL 字符，不能用于远端命令：${JSON.stringify(p)}`)
  if (p.length > REMOTE_PATH_MAX) throw new Error(`${what}超过 ${REMOTE_PATH_MAX} 字符`)
  if (!p.startsWith('/')) throw new Error(`${what}必须是绝对路径：${p}`)
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '..') throw new Error(`${what}不能含 . 或 .. 路径段：${p}`)
  }
  return p as RemotePath
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const WIN_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * 远端合法但 Windows 非法的文件名（con、a:b、尾部点/空格等）落地前 sanitize。
 * 非 win32 平台原样返回。
 */
export function sanitizeLocalName(name: string): string {
  if (process.platform !== 'win32') return name
  let out = name.replace(WIN_ILLEGAL, '_').replace(/[. ]+$/, '')
  if (WIN_RESERVED.test(out)) out = `_${out}`
  return out || '_'
}

/** 超长本地路径加 \\?\ 前缀（MAX_PATH 260） */
export function longPath(absolutePath: string): string {
  if (process.platform !== 'win32') return absolutePath
  if (absolutePath.length < 250 || absolutePath.startsWith('\\\\?\\')) return absolutePath
  if (absolutePath.startsWith('\\\\')) return `\\\\?\\UNC\\${absolutePath.slice(2)}`
  return `\\\\?\\${absolutePath}`
}

/** 冲突时生成 name (2).ext 形式的新名 */
export function dedupeName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}
