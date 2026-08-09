import { useEffect, useRef } from 'react'

interface Props {
  /** 主序列（面积 + 渐变）。百分比图传 0~100 的历史值 */
  primary: number[]
  /** 次要序列（叠加一条细线，不填充）。网络图的上行走这条 */
  secondary?: number[]
  height: number
  /** 固定上限（百分比图给 100）；不给则按两条序列的峰值自动缩放 */
  max?: number
  className?: string
}

/**
 * btop 风格的迷你趋势图：canvas 画一条填充面积折线，面积用**竖直渐变**
 * （底绿 → 中黄 → 顶红）——"越高越红"就是 btop 的招牌观感，把负载高低直接画进颜色里。
 * 顶线的颜色按**当前最新值**取绿/黄/红，一眼看出此刻状态。
 *
 * 取代原来的 echarts：那是全仓性价比最低的字节（~163KB gzip 只为画几张 48px 无轴小图），
 * 而这几张图本就只需要一条折线 + 一个渐变。手绘 canvas 零依赖、后台窗口也不受
 * echarts lazyUpdate 那个"不合成帧就不画"的坑影响。
 */

/** 面积渐变的色标（自下而上）。alpha 压低，避免糊成一片 */
const AREA_STOPS: Array<[number, string, number]> = [
  [0, '82, 196, 26', 0.06], // 底部：低负载，绿
  [0.5, '82, 196, 26', 0.22],
  [0.78, '250, 173, 20', 0.34], // 黄
  [1, '255, 77, 79', 0.5] // 顶部：高负载，红
]
const SECONDARY_COLOR = '250, 140, 22' // 上行/次要序列：橙

/** 按占比取状态色（顶线用）：与面板里 usageColor 同一套阈值 */
export function stateColor(ratio: number): string {
  if (ratio >= 0.9) return '#ff4d4f'
  if (ratio >= 0.75) return '#faad14'
  return '#52c41a'
}

/**
 * 图的纵向上限（缩放基准）。固定 max（百分比图给 100）优先；否则按两条序列的峰值
 * 自动缩放并留 8% 顶部余量，下限 1 —— 防除零，也防全 0 时峰值贴顶被画成满屏红。
 */
export function computePeak(
  primary: number[],
  secondary: number[] | undefined,
  max: number | undefined
): number {
  if (max !== undefined) return max
  const both = secondary ? primary.concat(secondary) : primary
  return Math.max(1, Math.max(0, ...both) * 1.08)
}

export function MonitorGraph({ primary, secondary, height, max, className }: Props): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    const draw = (): void => {
      const w = canvas.clientWidth
      const h = height
      if (w <= 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const peak = computePeak(primary, secondary, max)
      const yAt = (v: number): number => h - Math.min(1, Math.max(0, v / peak)) * (h - 1) - 0.5
      const xAt = (i: number, len: number): number => (len <= 1 ? w : (i / (len - 1)) * w)

      // 主序列：面积
      if (primary.length >= 2) {
        ctx.beginPath()
        ctx.moveTo(0, h)
        primary.forEach((v, i) => ctx.lineTo(xAt(i, primary.length), yAt(v)))
        ctx.lineTo(w, h)
        ctx.closePath()
        const grad = ctx.createLinearGradient(0, 0, 0, h)
        for (const [at, rgb, a] of AREA_STOPS) grad.addColorStop(at, `rgba(${rgb},${a})`)
        ctx.fillStyle = grad
        ctx.fill()

        // 顶线：颜色按最新值定
        const latest = primary[primary.length - 1] ?? 0
        ctx.beginPath()
        primary.forEach((v, i) => {
          const x = xAt(i, primary.length)
          const y = yAt(v)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.strokeStyle = max ? stateColor(latest / max) : stateColor(latest / peak)
        ctx.lineWidth = 1.5
        ctx.lineJoin = 'round'
        ctx.stroke()
      }

      // 次要序列：橙色细线，不填充
      if (secondary && secondary.length >= 2) {
        ctx.beginPath()
        secondary.forEach((v, i) => {
          const x = xAt(i, secondary.length)
          const y = yAt(v)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.strokeStyle = `rgba(${SECONDARY_COLOR},0.9)`
        ctx.lineWidth = 1
        ctx.lineJoin = 'round'
        ctx.stroke()
      }
    }

    draw()
    // 侧栏宽度会变（拖分隔条、折叠），宽度变了要重画
    const ro = new ResizeObserver(() => draw())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [primary, secondary, height, max])

  return <canvas ref={ref} className={className} style={{ width: '100%', height, display: 'block' }} />
}
