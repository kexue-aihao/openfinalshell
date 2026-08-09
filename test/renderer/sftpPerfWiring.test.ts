import { describe, expect, it } from 'vitest'
import { read, stripComments } from '../sourceGuard'

/**
 * SFTP 面板流畅性的接线护栏。护的是"回退了也不报错、只是重新变卡"的改法：
 * 有人把 useMemo 拆回内联、把纯函数搬回组件体内，编译照过、测试照绿，只有手感变差。
 */

const sftp = stripComments(read('src/renderer/src/features/sftp/SftpPane.tsx'))

describe('SFTP 虚拟表格的重渲染成本', () => {
  it('columns 必须 useMemo 缓存（内联重建会逼虚拟表格每次重算列布局）', () => {
    expect(sftp).toMatch(/const columns[^=]*=\s*useMemo\(/)
  })

  it('isDirEntry 是模块级纯函数，不在组件体内每次重建', () => {
    // 出现在文件顶部（import 之后、组件之前）：用它在源码里的位置早于 export function SftpPane 判定
    const declAt = sftp.indexOf('const isDirEntry')
    const compAt = sftp.indexOf('export function SftpPane')
    expect(declAt).toBeGreaterThan(0)
    expect(declAt).toBeLessThan(compAt)
  })

  it('选区成员判定走 Set，不用 selected.includes 的 O(n·m)', () => {
    expect(sftp).toContain('const selectedSet = useMemo(')
    // 热路径（targetsFor / selectedEntries）不许再出现数组 includes
    expect(sftp).toContain('selectedSet.has(')
  })

  it('目录导航期间给出加载反馈：Table 带 delay 的 loading 覆盖层', () => {
    // 双击进目录要跨一个网络往返，这期间旧内容还留着；delay 让秒开目录不闪、慢链路才现转圈
    expect(sftp).toMatch(/loading=\{\{\s*spinning:\s*loading,\s*delay:\s*\d+\s*\}\}/)
  })
})
