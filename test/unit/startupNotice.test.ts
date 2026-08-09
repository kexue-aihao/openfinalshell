import { describe, expect, it } from 'vitest'
import { classifyLaunch } from '../../src/main/services/startupNotice'

/**
 * 开机弹窗判定的纯逻辑：没记录=全新安装、记录变了=更新过、没变=不弹。
 * （getStartupNotice 的"读写 meta + 缓存"副作用不在这测，靠接线护栏 + 冒烟兜。）
 */
describe('classifyLaunch', () => {
  it('无记录 → fresh（全新安装）', () => {
    expect(classifyLaunch(null, '0.12.0')).toEqual({ kind: 'fresh', toVersion: '0.12.0' })
  })
  it('版本变了 → update，带 from/to', () => {
    expect(classifyLaunch('0.11.0', '0.12.0')).toEqual({
      kind: 'update',
      fromVersion: '0.11.0',
      toVersion: '0.12.0'
    })
  })
  it('版本没变 → none（不弹）', () => {
    expect(classifyLaunch('0.12.0', '0.12.0')).toEqual({ kind: 'none', toVersion: '0.12.0' })
  })
})
