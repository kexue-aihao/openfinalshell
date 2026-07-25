import type { OfsApi } from '@shared/ipc'
import { createMockOfs } from './mock'

/** preload 暴露的类型化 IPC 入口。任何 renderer 代码都应从这里取，禁止直摸 window.ofs */
function resolveOfs(): OfsApi {
  if (window.ofs) return window.ofs
  if (import.meta.env.DEV) {
    console.warn('[ofs] preload 未注入，使用浏览器 mock（仅 UI 调试）')
    return createMockOfs()
  }
  throw new Error('preload API (window.ofs) 未注入 —— preload 脚本加载失败')
}

export const ofs: OfsApi = resolveOfs()
