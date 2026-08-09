import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, shell } from 'electron'
import type { ConnectionProfile } from '@shared/types'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('rdp')

/**
 * RDP 走**系统自带远程桌面**，与用户双击一个 .rdp 文件完全同一条路：
 * 生成一份 .rdp → 用系统默认处理器打开（Windows 上就是 mstsc.exe）。
 *
 * 关键取舍：**密码永不写进 .rdp**。mstsc 会像平时一样弹 Windows 凭据框
 * （或用系统里已存的凭据 / NLA）——我们只预填主机、端口、用户名这些非机密项。
 * 这既符合"绝不代替用户输入密码"的红线，也正是系统 RDP 的原生工作方式。
 *
 * 不用 child_process 起 mstsc：`shell.openPath` 就是"双击这个 .rdp"，
 * 因此本文件**不触碰** localTar.ts 那条"全项目唯一 child_process"的铁律。
 */

/** .rdp 的值里出现换行会被解读成新指令（drive/printer 重定向、alternate shell 等），必须剥掉 */
function sanitizeValue(v: string): string {
  return v.replace(/[\r\n]/g, '').trim()
}

export function buildRdpContent(profile: ConnectionProfile): string {
  const host = sanitizeValue(profile.host)
  const port = profile.port && profile.port > 0 ? profile.port : 3389
  const username = sanitizeValue(profile.username)
  const lines = [
    `full address:s:${host}:${port}`,
    // 让系统在需要时弹凭据框；绝不在文件里放密码
    'prompt for credentials:i:1',
    // 允许连接但对证书不匹配给出警告（等同 mstsc 默认体验）
    'authentication level:i:2',
    'screen mode id:i:2', // 全屏
    'redirectclipboard:i:1'
  ]
  // 用户名可留空（让系统问）；填了就预填，省一次输入
  if (username) lines.push(`username:s:${username}`)
  // \r\n 结尾：.rdp 是 Windows 文件格式，mstsc 对行尾敏感
  return lines.join('\r\n') + '\r\n'
}

/**
 * 生成 .rdp 并交给系统打开。文件名按 profile id，避免并发/多次打开互相覆盖到脏内容；
 * 放 userData 下（可写、随卸载清理）。`shell.openPath` 成功返回空串，失败返回错误描述。
 */
export async function launchRdp(profile: ConnectionProfile): Promise<void> {
  if (!profile.host.trim()) throw new Error('这条 RDP 连接没有填写主机地址')
  const file = join(app.getPath('userData'), `rdp-${profile.id}.rdp`)
  await writeFile(file, buildRdpContent(profile), 'utf8')
  const err = await shell.openPath(file)
  if (err) {
    // 常见于非 Windows（没有 .rdp 处理器）或没装远程桌面客户端
    log.warn(`openPath(${file}) failed: ${err}`)
    throw new Error(`无法启动系统远程桌面：${err}`)
  }
  log.info(`launched RDP to ${profile.host} via system handler`)
}
