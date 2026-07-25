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
