import { useEffect, useRef, useState } from 'react'

/**
 * 观测一个元素的内容高度。返回 0 = 还没量到（调用方此时该走非虚拟化兜底）。
 *
 * ⚠️ 用 `clientHeight` 而**不是** `getBoundingClientRect().height`：
 * App.tsx 给 documentElement 设了 `zoom`（界面缩放），rect 返回的是缩放**后**的坐标，
 * 而 scrollTop/clientHeight 是元素自己 CSS 像素坐标系里的值。两者混算会在
 * 缩放 ≠ 100% 时产生随缩放线性放大的错位 —— 表现是"滚到中间就空一块"。
 * 窗口化的数学必须整套待在同一个坐标系里。
 */
export function useElementHeight<T extends HTMLElement>(): [React.RefObject<T>, number] {
  // React 18 的 ref 类型：初值给 null 但对外宣称 RefObject<T>，与 useRef<T>(null!) 同款
  const ref = useRef<T>(null as unknown as T)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setHeight(el.clientHeight)
    measure()
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, height]
}
