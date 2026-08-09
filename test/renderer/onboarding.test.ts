import { describe, expect, it } from 'vitest'
import {
  RELEASE_NOTES,
  compareVersions,
  notesSince
} from '@/features/onboarding/releaseNotes'
import { read, stripComments } from '../sourceGuard'

describe('compareVersions', () => {
  it('按数字段比较', () => {
    expect(compareVersions('0.12.0', '0.11.0')).toBe(1)
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1) // 9 < 10，不是字符串比较
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.12.1', '0.12.0')).toBe(1)
  })
})

describe('notesSince：取 (from, to] 的更新说明', () => {
  it('跨版本更新一次看全被跳过的版本，按新→旧', () => {
    const v = notesSince('0.9.0', '0.12.0').map((n) => n.version)
    expect(v).toEqual(['0.12.0', '0.11.0', '0.10.0']) // 排除 0.9.0（=from），含到 0.12.0
  })
  it('相邻版本只给目标那条', () => {
    expect(notesSince('0.11.0', '0.12.0').map((n) => n.version)).toEqual(['0.12.0'])
  })
  it('from 缺省时只给 to 那条', () => {
    expect(notesSince(undefined, '0.12.0').map((n) => n.version)).toEqual(['0.12.0'])
  })
  it('每条更新说明都有至少一项、且类型是 feat/fix', () => {
    for (const n of RELEASE_NOTES) {
      expect(n.items.length).toBeGreaterThan(0)
      for (const it of n.items) expect(['feat', 'fix']).toContain(it.type)
    }
  })
})

describe('维护护栏：当前版本必须有更新说明', () => {
  it('package.json 的版本在 RELEASE_NOTES 里（发版忘了加会红）', () => {
    const version = JSON.parse(read('package.json')).version as string
    const versions = RELEASE_NOTES.map((n) => n.version)
    expect(versions, `请在 releaseNotes.ts 顶部补上 v${version} 的更新说明`).toContain(version)
    // 且更新弹窗对"更新到当前版本"至少能显示一条
    expect(notesSince('0.0.0', version).length).toBeGreaterThan(0)
  })
})

describe('接线护栏', () => {
  it('App 挂了 StartupNoticeModal', () => {
    const app = stripComments(read('src/renderer/src/App.tsx'))
    expect(app).toContain("from '@/features/onboarding/StartupNoticeModal'")
    expect(app).toContain('<StartupNoticeModal')
  })
  it('IPC 通道与 main 处理器都在（否则弹窗永远拿不到判定）', () => {
    const ipc = stripComments(read('src/shared/ipc.ts'))
    expect(ipc).toContain("'app:getStartupNotice'")
    const handler = stripComments(read('src/main/ipc/app.ipc.ts'))
    expect(handler).toContain("handle('app:getStartupNotice'")
  })
  it('getStartupNotice 会把当前版本记为已见（同版本下次不再弹）', () => {
    const svc = stripComments(read('src/main/services/startupNotice.ts'))
    expect(svc).toContain('metaSet(')
    expect(svc).toContain('classifyLaunch(')
  })
})
