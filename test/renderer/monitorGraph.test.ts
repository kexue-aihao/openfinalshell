import { describe, expect, it } from 'vitest'
import { computePeak, stateColor } from '@/features/monitor/MonitorGraph'

/**
 * btop 风格趋势图的数值核心。像素好不好看没法测，但缩放基准算错会让图形贴顶/贴底或
 * 全屏一片颜色 —— 那些是能测的，也是最容易悄悄错的。
 */

describe('computePeak：纵向缩放基准', () => {
  it('固定 max（百分比图）优先，无视数据峰值', () => {
    expect(computePeak([10, 200, 50], undefined, 100)).toBe(100)
  })

  it('无 max 时按峰值自动缩放，留 8% 顶部余量', () => {
    expect(computePeak([0, 50, 100], undefined, undefined)).toBeCloseTo(108, 5)
  })

  it('两条序列都参与取峰（网络图的上行不能被下行盖掉）', () => {
    // 上行峰值更高时，峰值要认上行，否则上行线会冲出画布顶
    expect(computePeak([10, 20], [10, 500], undefined)).toBeCloseTo(540, 5)
  })

  it('全 0 / 空数据下限为 1，绝不返回 0（防除零 + 防满屏红）', () => {
    expect(computePeak([0, 0, 0], undefined, undefined)).toBe(1)
    expect(computePeak([], undefined, undefined)).toBe(1)
    expect(computePeak([], [], undefined)).toBe(1)
  })
})

describe('stateColor：顶线状态色阈值', () => {
  it('<75% 绿 / 75~90% 黄 / ≥90% 红', () => {
    expect(stateColor(0)).toBe('#52c41a')
    expect(stateColor(0.74)).toBe('#52c41a')
    expect(stateColor(0.75)).toBe('#faad14')
    expect(stateColor(0.89)).toBe('#faad14')
    expect(stateColor(0.9)).toBe('#ff4d4f')
    expect(stateColor(1)).toBe('#ff4d4f')
  })
})
