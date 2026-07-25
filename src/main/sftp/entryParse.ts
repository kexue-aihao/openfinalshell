import type { RemoteFileType, SftpEntry } from '@shared/types'
import { remoteJoin, type RemotePath } from './remotePath'

/** POSIX 权限位 → rwxr-xr-x 形式 */
export function modeToString(mode: number, type: RemoteFileType): string {
  const typeChar = type === 'dir' ? 'd' : type === 'symlink' ? 'l' : '-'
  const bits = ['r', 'w', 'x']
  let out = typeChar
  for (let shift = 6; shift >= 0; shift -= 3) {
    const part = (mode >> shift) & 0b111
    for (let i = 0; i < 3; i++) {
      out += part & (0b100 >> i) ? bits[i] : '-'
    }
  }
  return out
}

/** ssh2 的 mode 里的文件类型位（S_IFMT） */
export function typeFromMode(mode: number): RemoteFileType {
  const fmt = mode & 0o170000
  if (fmt === 0o040000) return 'dir'
  if (fmt === 0o120000) return 'symlink'
  if (fmt === 0o100000) return 'file'
  return 'other'
}

/**
 * 从 readdir 的 longname（`-rw-r--r-- 1 root root 1234 Jan 1 00:00 name`）里取属主/组。
 * 各家 sftp-server 的 longname 格式不完全一致，取不到就留空 —— 不做强解析。
 */
export function ownerFromLongname(longname: string): { owner: string; group: string } {
  const parts = longname.trim().split(/\s+/)
  if (parts.length >= 4 && /^[-dlbcps]/.test(parts[0])) {
    return { owner: parts[2] ?? '', group: parts[3] ?? '' }
  }
  return { owner: '', group: '' }
}

/** 文件名含 U+FFFD 说明服务器编码非 UTF-8，ssh2 已有损解码，无法可靠操作 */
export function hasBadName(name: string): boolean {
  return name.includes('�')
}

export interface RawDirEntry {
  filename: string
  longname: string
  attrs: { mode: number; size: number; mtime: number; uid?: number; gid?: number }
}

export function toSftpEntry(dir: RemotePath, raw: RawDirEntry): SftpEntry {
  const type = typeFromMode(raw.attrs.mode)
  const { owner, group } = ownerFromLongname(raw.longname)
  return {
    name: raw.filename,
    path: remoteJoin(dir, raw.filename),
    type,
    size: raw.attrs.size,
    mode: raw.attrs.mode & 0o7777,
    modeStr: modeToString(raw.attrs.mode, type),
    owner: owner || String(raw.attrs.uid ?? ''),
    group: group || String(raw.attrs.gid ?? ''),
    mtime: raw.attrs.mtime * 1000,
    badName: hasBadName(raw.filename) || undefined
  }
}

/** 人类可读的字节数 */
export function formatBytes(bytes: number): string {
  if (bytes < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`
}
