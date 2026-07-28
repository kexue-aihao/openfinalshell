import type { UpdateActivity } from '@shared/types'

/**
 * 安装更新前那一道闸门 —— **这个文件刻意不 import electron-updater**。
 *
 * 两个理由：
 *
 * 1. 它是整片更新功能里唯一"错了有后果"的判断：漏判就等于**在不问的情况下**
 *    拆掉用户所有的终端会话、取消正在跑的传输、断掉端口转发。
 * 2. `updater.ts` 因为 import electron-updater（CJS + 要真 electron 运行时）
 *    在 node 测试环境里根本加载不了，那里面的东西只能靠源码护栏与打包冒烟守。
 *    把这一条判断挪出来，它就能有真正的行为用例。
 *
 * 与内置编辑器保存那三道闸门是同一套思路：main 侧持有事实、界面负责问、
 * 用户确认后带着 force 再来一次。
 */

/**
 * 有没有"会被这次安装打断"的东西。
 *
 * 判据是**三者任一 > 0**，而不是"会话数 > 0"：一个没有终端会话、但正在跑一个
 * 4GB 传输的窗口同样不该被静默重启。转发也算 —— 别人可能正通过那条隧道连着数据库。
 */
export function hasLiveWork(activity: UpdateActivity): boolean {
  return activity.sessions > 0 || activity.transfers > 0 || activity.forwards > 0
}

/**
 * 这一次 `update:install` 该做什么。
 *
 * 刻意把"没下载完"也放在这里：它与闸门是同一类判断（"现在还不能装"），
 * 放在一处才能保证顺序稳定 —— 先看能不能装，再看要不要问。
 */
export type InstallDecision =
  | { kind: 'install' }
  | { kind: 'confirm'; activity: UpdateActivity }
  | { kind: 'reject'; reason: 'notPackaged' | 'portable' | 'notDownloaded' }

export function decideInstall(input: {
  packaged: boolean
  portable: boolean
  downloaded: boolean
  force: boolean
  activity: UpdateActivity
}): InstallDecision {
  if (!input.packaged) return { kind: 'reject', reason: 'notPackaged' }
  if (input.portable) return { kind: 'reject', reason: 'portable' }
  if (!input.downloaded) return { kind: 'reject', reason: 'notDownloaded' }
  // force 只越过"要不要问"这一道，越不过上面三条 —— 那三条不是用户确认能解决的
  if (!input.force && hasLiveWork(input.activity)) {
    return { kind: 'confirm', activity: input.activity }
  }
  return { kind: 'install' }
}
