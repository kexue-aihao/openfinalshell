import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { read, stripComments } from '../sourceGuard'

/**
 * 监控面板 btop 化的接线护栏：确认真的换成了 canvas 图、echarts 被彻底移除
 * （否则删了组件却留着依赖，包白背 163KB gzip 却没人发现）。
 */

const panel = stripComments(read('src/renderer/src/features/monitor/MonitorPanel.tsx'))

describe('监控 btop 化', () => {
  it('面板用 MonitorGraph，不再用 EChart', () => {
    expect(panel).toContain('MonitorGraph')
    expect(panel).not.toContain('EChart')
    expect(panel).not.toContain('areaOption')
  })

  it('echarts 相关文件已删除', () => {
    expect(existsSync('src/renderer/src/components/EChart.tsx')).toBe(false)
    expect(existsSync('src/renderer/src/features/monitor/charts.ts')).toBe(false)
  })

  it('全渲染进程不再 import echarts；package.json 也摘掉了依赖', () => {
    // 组件层：查真正的 import 语句，不查注释里提到的字眼
    for (const f of [
      'src/renderer/src/features/monitor/MonitorPanel.tsx',
      'src/renderer/src/features/monitor/MonitorGraph.tsx'
    ]) {
      expect(read(f)).not.toMatch(/from ['"]echarts/)
    }
    // 依赖清单：不再声明 echarts
    expect(read('package.json')).not.toMatch(/"echarts"\s*:/)
  })
})
