import type { EChartsOption } from 'echarts'
import { HISTORY_LEN } from '@/stores/useMonitorStore'

const GRID = { left: 0, right: 0, top: 4, bottom: 0, containLabel: false }

/**
 * boundaryGap 按系列类型给：折线要 false（首尾点顶到网格边缘，趋势线满宽）；
 * 柱状必须 true —— false 时柱子以类目点居中绘制，首尾两根被网格边缘裁掉半根，
 * 而最右那根正是"当前值"，最不该缺的就是它
 */
function xAxisSlots(boundaryGap = false): EChartsOption['xAxis'] {
  return {
    type: 'category',
    show: false,
    boundaryGap,
    data: Array.from({ length: HISTORY_LEN }, (_, i) => String(i))
  }
}

/** 单序列面积折线（CPU / 内存） */
export function areaOption(values: number[], color: string, max = 100): EChartsOption {
  const padded = [...Array(Math.max(0, HISTORY_LEN - values.length)).fill(null), ...values]
  return {
    animation: false,
    grid: GRID,
    xAxis: xAxisSlots(),
    yAxis: { type: 'value', show: false, min: 0, max },
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: (params: unknown) => {
        const arr = params as Array<{ value: number | null }>
        const v = arr[0]?.value
        return v === null || v === undefined ? '' : `${Number(v).toFixed(1)}%`
      }
    },
    series: [
      {
        type: 'line',
        data: padded,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.5, color },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${color}66` },
              { offset: 1, color: `${color}05` }
            ]
          }
        }
      }
    ]
  }
}

/** 延迟分档配色（阈值对齐 FinalShell 的肌肉记忆：<100 绿 / <200 黄 / 其余红） */
export function latencyColor(ms: number): string {
  if (ms < 100) return '#52c41a'
  if (ms < 200) return '#faad14'
  return '#ff4d4f'
}

/** 延迟迷你柱状图：逐柱按值分档着色（echarts 画布读不到 CSS 变量，只能给具体色值） */
export function latencyBarOption(values: number[]): EChartsOption {
  const padded = [...Array(Math.max(0, HISTORY_LEN - values.length)).fill(null), ...values]
  return {
    animation: false,
    grid: GRID,
    xAxis: xAxisSlots(true),
    yAxis: { type: 'value', show: false, min: 0 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: (params: unknown) => {
        const arr = params as Array<{ value: number | null }>
        const v = arr[0]?.value
        return v === null || v === undefined ? '' : `${Math.round(Number(v))} ms`
      }
    },
    series: [
      {
        type: 'bar',
        data: padded,
        barCategoryGap: '25%',
        itemStyle: {
          color: (p: { value?: unknown }) =>
            typeof p.value === 'number' ? latencyColor(p.value) : '#52c41a'
        }
      }
    ]
  }
}

/** 双序列折线（网络下行/上行） */
export function dualLineOption(
  down: number[],
  up: number[],
  downColor: string,
  upColor: string,
  formatBytes: (n: number) => string
): EChartsOption {
  const pad = (values: number[]): Array<number | null> => [
    ...Array(Math.max(0, HISTORY_LEN - values.length)).fill(null),
    ...values
  ]
  return {
    animation: false,
    grid: GRID,
    xAxis: xAxisSlots(),
    yAxis: { type: 'value', show: false, min: 0 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: (params: unknown) => {
        const arr = params as Array<{ seriesName: string; value: number | null }>
        return arr
          .filter((p) => p.value !== null && p.value !== undefined)
          .map((p) => `${p.seriesName} ${formatBytes(Number(p.value))}/s`)
          .join('<br/>')
      }
    },
    series: [
      {
        name: '↓',
        type: 'line',
        data: pad(down),
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.5, color: downColor },
        areaStyle: { color: `${downColor}22` }
      },
      {
        name: '↑',
        type: 'line',
        data: pad(up),
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.5, color: upColor },
        areaStyle: { color: `${upColor}22` }
      }
    ]
  }
}
