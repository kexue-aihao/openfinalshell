import { homedir } from 'node:os'

/**
 * 展开用户手填路径里的 `~` 前缀与 Windows 环境变量（%USERPROFILE% 等）。
 *
 * 只在**读文件那一刻**调用 —— 存储层保留用户的原始输入不动：
 * 导出的配置带 `~/.ssh/id_ed25519` 拿到另一台机器上导入，展开结果跟着新机器走，
 * 这正是保留原始输入的意义。
 *
 * 规则刻意保守：
 * - `~` 只认「整个路径就是 ~」或「~/ 与 ~\ 前缀」，不做 `~user` 展开（OpenSSH 客户端也不做）
 * - `%VAR%` 只在 Windows 上展开（POSIX 语义里 % 是合法文件名字符），查不到的变量原样保留
 *   —— 静默替换成空串会把路径悄悄改坏，报"读不到文件：原样路径"反而可诊断
 */
export function expandPath(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  let p = raw.trim()
  if (p === '~') {
    p = homedir()
  } else if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = homedir() + p.slice(1)
  }
  if (process.platform === 'win32') {
    p = p.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole)
  }
  return p
}
