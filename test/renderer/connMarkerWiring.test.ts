import { describe, expect, it } from 'vitest'
import { read, stripComments } from '../sourceGuard'

/**
 * 连接位置标记的接线护栏：树节点按 effectiveMarker 优先级显示、抽屉能选 flag、
 * flag 一路落到 zod/save/import（漏一处，选了国旗但存不住/导入丢）。
 */

const tree = stripComments(read('src/renderer/src/features/connections/ConnectionTreePanel.tsx'))
const drawer = stripComments(read('src/renderer/src/features/connections/ProfileEditDrawer.tsx'))
const ipc = stripComments(read('src/main/ipc/conn.ipc.ts'))
const store = stripComments(read('src/main/store/connections.ts'))
const importer = stripComments(read('src/main/services/importData.ts'))

describe('树节点显示', () => {
  it('用 effectiveMarker（显式旗 > 私网自动LAN > 颜色点回退），不是直接读 flag', () => {
    expect(tree).toContain('effectiveMarker(p.flag, p.host)')
    expect(tree).toContain('<RegionMarker')
    // 回退：没标记才显示颜色点
    expect(tree).toContain('p.color')
  })
})

describe('抽屉选择器', () => {
  it('用 flag 字段的 Select（REGIONS 选项），不再是颜色 Radio', () => {
    expect(drawer).toContain('name="flag"')
    expect(drawer).toContain('REGIONS.map')
    expect(drawer).not.toContain('name="color"')
  })

  it('提交与初始化都带 flag（存得住、编辑能回显）', () => {
    expect(drawer).toContain('flag: v.flag || undefined')
    expect(drawer).toContain('flag: editing.flag')
  })
})

describe('flag 一路落库', () => {
  it('zod 收 flag', () => {
    expect(ipc).toContain('flag: z.string()')
  })
  it('saveProfile 落 flag', () => {
    expect(store).toContain('flag: draft.flag')
  })
  it('导入携带 flag', () => {
    expect(importer).toContain('flag: p.flag')
  })
})
