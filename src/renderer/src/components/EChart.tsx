import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, CanvasRenderer])

interface Props {
  option: EChartsOption
  height: number
  /** 数据变化时用 notMerge=false 增量更新，避免重建整个图 */
  className?: string
}

/**
 * ECharts 薄封装：实例常驻、ResizeObserver 自适应。
 * 监控数据不进 React state —— 由父组件持 ref 直接 setOption。
 */
export function EChart({ option, height, className }: Props): React.JSX.Element {
  const elRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!elRef.current) return
    const chart = echarts.init(elRef.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(elRef.current)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    // 不用 lazyUpdate：它把绘制推到 rAF，页面未合成帧时（后台窗口）会一直不画
    chartRef.current?.setOption(option, { notMerge: false })
  }, [option])

  return <div ref={elRef} className={className} style={{ width: '100%', height }} />
}
