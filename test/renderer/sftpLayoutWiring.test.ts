import { describe, expect, it } from 'vitest'
import { read, stripComments } from '../sourceGuard'

/**
 * SFTP 面板尺寸的接线护栏。
 *
 * 两个问题的共同点是「编译照过、跑起来不抛，只是用久了才发现」：
 * 1. 分隔条 onResize 每帧 patch → settings:set 的 expected 校验撞车 → CONFIG_CONFLICT 刷屏；
 * 2. 虚拟表格写死 scroll.y → 面板拖高后列表不跟着长，底部留一块空白。
 * 所以这里直接钉住源码里的关键接线，防止后续「简化」时又退回去。
 */

const sessionView = stripComments(read('src/renderer/src/features/sessions/SessionView.tsx'))
const sftp = stripComments(read('src/renderer/src/features/sftp/SftpPane.tsx'))
const sftpCss = stripComments(read('src/renderer/src/features/sftp/SftpPane.module.css'))

describe('会话面板尺寸持久化', () => {
  it('拖拽事件合并后再落盘（每帧 patch 会撞上 settings:set 的 expected 校验）', () => {
    const start = sessionView.indexOf('onResize={(size)')
    expect(start).toBeGreaterThan(-1)
    const end = sessionView.indexOf('window.setTimeout(flushLayout', start)
    expect(end).toBeGreaterThan(start)
    const onResize = sessionView.slice(start, end)

    expect(onResize).not.toContain('patch(')
    expect(sessionView).toMatch(/window\.setTimeout\(flushLayout,\s*180\)/)
  })

  it('落盘时重新读取最新 layout，不覆盖拖拽期间其它布局改动', () => {
    expect(sessionView).toContain('useSettingsStore.getState().settings?.layout')
    expect(sessionView).toMatch(/\.\.\.latest,\s*sftpPaneHeightPct:\s*size/)
  })
})

describe('SFTP 虚拟表格高度', () => {
  it('Table 用测量出来的高度，不再写死 220', () => {
    expect(sftp).toContain('ref={setTableEl}')
    expect(sftp).toMatch(/scroll=\{\{\s*y:\s*tableScrollY,\s*x:\s*620\s*\}\}/)
    expect(sftp).not.toMatch(/scroll=\{\{\s*y:\s*220/)
  })

  it('用 ResizeObserver 跟着 Panel 高度重测，且以回调 ref 保证表格挂载后才观察', () => {
    expect(sftp).toMatch(/new ResizeObserver\(measure\)/)
    expect(sftp).toMatch(/ro\.observe\(tableEl\)/)
    // 没有表头（骨架/错误态）时保留上次的值，别把列表压成 0
    expect(sftp).toMatch(/if \(!thead\) return/)
  })

  it('骨架占位用确定高度撑满容器（flex:1 在非 flex 父级里无效）', () => {
    expect(sftpCss).toMatch(/\.skeletonWrap\s*\{[^}]*height:\s*100%/)
    expect(sftpCss).toMatch(/\.pane\s*\{[^}]*height:\s*100%/)
  })
})
