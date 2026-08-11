/**
 * 组件测试（jsdom）的环境铺垫。经 vitest 的 setupFiles 在**每个测试文件求值之前**跑，
 * 所以 window.ofs 一定先于 `@/ipc/api` 的模块求值就位（那边是模块常量，晚了就捕获不到）。
 *
 * 整个文件对 node 环境的测试是 no-op（typeof window 守卫），不影响既有 1300+ 条用例。
 */
import { installFakeOfs } from './fakeOfs'

if (typeof window !== 'undefined') {
  installFakeOfs()

  // React 18：不设它，act() 会告警"当前环境未配置支持 act"
  ;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

  // antd 的响应式与主题探测用；jsdom 没有实现
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false
      })
    })
  }

  // antd 虚拟表格（rc-virtual-list / rc-resize-observer）要求存在；量不出尺寸没关系，
  // 组件测试断言的是状态切换（骨架/面包屑/错误态），不是行渲染
  if (!('ResizeObserver' in window)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    ;(window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub
  }

  // jsdom 的 Element 没有 scrollTo（虚拟列表滚动用）
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
}
