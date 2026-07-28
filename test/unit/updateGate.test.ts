import { describe, expect, it } from 'vitest'
import { decideInstall, hasLiveWork } from '../../src/main/services/updateGate'

/**
 * 安装更新前那道闸门。
 *
 * 这是整片更新功能里唯一"错了有后果"的判断 —— 漏判就等于**在不问的情况下**
 * 拆掉用户所有终端会话、取消正在跑的传输、断掉端口转发。
 * （updater.ts 本身在 node 里加载不了：它 import electron-updater。所以判断在这儿。）
 */

const none = { sessions: 0, transfers: 0, forwards: 0 }
const base = { packaged: true, portable: false, downloaded: true, force: false }

describe('有没有会被打断的东西', () => {
  it('三者任一 > 0 都算', () => {
    expect(hasLiveWork(none)).toBe(false)
    expect(hasLiveWork({ ...none, sessions: 1 })).toBe(true)
    // 没有会话但正在跑一个大传输，同样不该被静默重启
    expect(hasLiveWork({ ...none, transfers: 1 })).toBe(true)
    // 转发也算：别人可能正通过那条隧道连着数据库
    expect(hasLiveWork({ ...none, forwards: 1 })).toBe(true)
  })
})

describe('要不要先问', () => {
  it('闲着就直接装', () => {
    expect(decideInstall({ ...base, activity: none })).toEqual({ kind: 'install' })
  })

  it('有活儿就回一份清单让界面去问，一个字节都不装', () => {
    const activity = { sessions: 3, transfers: 2, forwards: 1 }
    expect(decideInstall({ ...base, activity })).toEqual({ kind: 'confirm', activity })
  })

  it('force 只越过"要不要问"这一道', () => {
    const activity = { sessions: 3, transfers: 2, forwards: 1 }
    expect(decideInstall({ ...base, force: true, activity })).toEqual({ kind: 'install' })
  })
})

describe('三条硬拒（force 越不过）', () => {
  it('开发模式 / 免安装版 / 还没下载完', () => {
    expect(decideInstall({ ...base, packaged: false, force: true, activity: none })).toEqual({
      kind: 'reject',
      reason: 'notPackaged'
    })
    expect(decideInstall({ ...base, portable: true, force: true, activity: none })).toEqual({
      kind: 'reject',
      reason: 'portable'
    })
    expect(decideInstall({ ...base, downloaded: false, force: true, activity: none })).toEqual({
      kind: 'reject',
      reason: 'notDownloaded'
    })
  })

  /** 顺序要稳定：先看"能不能装"，再看"要不要问" */
  it('既没打包又有活儿时报的是硬拒，而不是让界面弹一个白问的框', () => {
    expect(
      decideInstall({ ...base, packaged: false, activity: { sessions: 5, transfers: 0, forwards: 0 } })
    ).toEqual({ kind: 'reject', reason: 'notPackaged' })
  })
})
