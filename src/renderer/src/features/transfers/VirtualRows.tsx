import { useCallback, useEffect, useRef, useState } from 'react'
import { rowIndexAt } from './aggregate'

/**
 * 手写的窗口化列表容器。**零依赖** —— 体积卡口（JS gzip 只剩 ~76KB 余量）
 * 不允许为这一件事引一个 6–20KB 的库，而 antd 那两个候选都不合用：
 * `<Table virtual>` 要求行高一致且 expandable + virtual 在 antd 5 不支持，
 * `<List>` 根本没有虚拟化能力。
 *
 * 两条实现纪律：
 *
 * 1. **只用同一个滚动元素的 scrollTop / clientHeight，绝不混 getBoundingClientRect**
 *    （理由见 useElementHeight 的说明：界面缩放会让两个坐标系错开）。
 * 2. 可见行用绝对定位摆在 offsets[i] 上，而不是"顶部塞一个占位 div"。
 *    这样窗口滑动时行的 DOM 结构完全不变，antd 的 Progress 不会因为父节点重排
 *    丢掉过渡动画。
 */
export interface VirtualRowsProps<T> {
  rows: readonly T[]
  /** 与 rows 同长的累积偏移（rows[i] 的 top） */
  offsets: readonly number[]
  totalHeight: number
  heightOf: (index: number) => number
  /** 视口高度。0 表示还没量到 —— 调用方应该此时走平铺兜底，别传 0 进来 */
  viewportHeight: number
  overscan?: number
  /** 行的下标由容器内部消化（heightOf 已经拿到了），调用方只需要 row + 定位样式 */
  renderRow: (row: T, style: React.CSSProperties) => React.ReactNode
  className?: string
}

export function VirtualRows<T>({
  rows,
  offsets,
  totalHeight,
  heightOf,
  viewportHeight,
  overscan = 4,
  renderRow,
  className
}: VirtualRowsProps<T>): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0)
  const frameRef = useRef(0)
  const elRef = useRef<HTMLDivElement | null>(null)

  // rAF 节流：快速滚动时一帧内会来十几个 scroll 事件，逐个 setState 是白烧
  const onScroll = useCallback((): void => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      setScrollTop(elRef.current?.scrollTop ?? 0)
    })
  }, [])

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  const first = Math.max(0, rowIndexAt(offsets, scrollTop) - overscan)
  const last = Math.min(rows.length - 1, rowIndexAt(offsets, scrollTop + viewportHeight) + overscan)

  const visible: React.ReactNode[] = []
  for (let i = first; i <= last; i++) {
    visible.push(
      renderRow(rows[i], {
        position: 'absolute',
        top: offsets[i],
        left: 0,
        right: 0,
        height: heightOf(i),
        boxSizing: 'border-box'
      })
    )
  }

  return (
    <div
      ref={elRef}
      className={className}
      onScroll={onScroll}
      style={{ position: 'relative', overflowY: 'auto', height: viewportHeight }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>{visible}</div>
    </div>
  )
}
