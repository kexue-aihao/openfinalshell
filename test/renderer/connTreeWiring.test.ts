import { describe, expect, it } from 'vitest'
import { read, stripComments } from '../sourceGuard'

/**
 * 连接树"备注显示 + 默认展开"的接线护栏。护的是回退了也不报错、只是功能悄悄消失的改法。
 */

const tree = stripComments(read('src/renderer/src/features/connections/ConnectionTreePanel.tsx'))
const drawer = stripComments(read('src/renderer/src/features/connections/ProfileEditDrawer.tsx'))

describe('备注', () => {
  it('备注字段在抽屉主区，不埋进高级选项 Collapse', () => {
    // note 的 Form.Item 必须出现在 <Collapse 之前（主区），而不是 Collapse 里面
    const noteAt = drawer.indexOf('name="note"')
    const collapseAt = drawer.indexOf('<Collapse')
    expect(noteAt).toBeGreaterThan(0)
    expect(noteAt).toBeLessThan(collapseAt)
    // 且全文件只有一个 note 字段（此前 SSH/RDP 各一个，已合并）
    expect(drawer.match(/name="note"/g)).toHaveLength(1)
  })

  it('树节点展示备注（有备注时行内显示它，Tooltip 兜住完整信息）', () => {
    expect(tree).toContain('p.note || `${p.username}@${p.host}`')
    expect(tree).toContain('<Tooltip')
  })
})

describe('默认展开', () => {
  it('受控 expandedKeys + seenGroups：启动展开全部分组，用户折叠过的不再强展', () => {
    expect(tree).toContain('const [expandedKeys, setExpandedKeys]')
    expect(tree).toContain('seenGroups')
    expect(tree).toContain('expandedKeys={searchText.trim() ? undefined : expandedKeys}')
    expect(tree).toContain('onExpand={(keys) => setExpandedKeys(keys)}')
  })
})
