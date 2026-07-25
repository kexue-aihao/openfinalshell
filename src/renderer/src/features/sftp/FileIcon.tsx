import {
  Archive,
  File,
  FileCode,
  FileCog,
  FileImage,
  FileText,
  Folder,
  Link2,
  Terminal
} from 'lucide-react'
import type { SftpEntry } from '@shared/types'

const EXT_MAP: Array<{ re: RegExp; icon: typeof File; color: string }> = [
  { re: /\.(zip|tar|gz|bz2|xz|7z|rar|tgz)$/i, icon: Archive, color: '#faad14' },
  { re: /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i, icon: FileImage, color: '#13c2c2' },
  { re: /\.(sh|bash|zsh|fish)$/i, icon: Terminal, color: '#52c41a' },
  {
    re: /\.(js|ts|tsx|jsx|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|lua|sql)$/i,
    icon: FileCode,
    color: '#1677ff'
  },
  { re: /\.(json|ya?ml|toml|ini|conf|cfg|env|properties)$/i, icon: FileCog, color: '#722ed1' },
  { re: /\.(txt|md|log|rst)$/i, icon: FileText, color: '#8c8c8c' }
]

export function FileIcon({ entry, size = 14 }: { entry: SftpEntry; size?: number }): React.JSX.Element {
  if (entry.type === 'dir' || (entry.type === 'symlink' && entry.targetType === 'dir')) {
    return <Folder size={size} strokeWidth={1.75} color="#faad14" style={{ flex: 'none' }} />
  }
  if (entry.type === 'symlink') {
    return <Link2 size={size} strokeWidth={1.75} color="#13c2c2" style={{ flex: 'none' }} />
  }
  const match = EXT_MAP.find((m) => m.re.test(entry.name))
  const Icon = match?.icon ?? File
  return (
    <Icon
      size={size}
      strokeWidth={1.75}
      color={match?.color ?? 'var(--ofs-text-3)'}
      style={{ flex: 'none' }}
    />
  )
}
