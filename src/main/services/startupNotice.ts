import { app } from 'electron'
import type { StartupNotice } from '@shared/types'
import { metaGet, metaSet, tx } from '../store/Database'

/**
 * 开机弹窗判定：全新安装弹"功能/快捷键"引导，增量更新弹"更新了什么"。
 *
 * 判据是"上次启动记录的版本"（meta 里的 last_launched_version）与当前版本的比对：
 *  - 没有记录        → 全新安装（fresh）
 *  - 记录 ≠ 当前     → 更新过（update，带上 from→to）
 *  - 记录 == 当前     → 没变（none）
 *
 * 首次读取即把当前版本写回并在进程内缓存 —— 于是同一版本只判定一次、下次启动同版本返回 none。
 */

const META_KEY = 'last_launched_version'
let cached: StartupNotice | null = null

/** 纯比对逻辑（抽出来好单测，不碰 DB/electron） */
export function classifyLaunch(last: string | null, current: string): StartupNotice {
  if (!last) return { kind: 'fresh', toVersion: current }
  if (last !== current) return { kind: 'update', fromVersion: last, toVersion: current }
  return { kind: 'none', toVersion: current }
}

export function getStartupNotice(): StartupNotice {
  if (cached) return cached
  return tx(() => {
    const current = app.getVersion()
    const last = metaGet(META_KEY)
    // Only cache after persistence succeeds; a busy database must permit a later retry.
    metaSet(META_KEY, current)
    cached = classifyLaunch(last, current)
    return cached
  })
}
