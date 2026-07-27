import { create } from 'zustand'
import type { RemoteCharset } from '@shared/constants'
import type { RemoteFileView, SessionId } from '@shared/types'
import { ofs } from '@/ipc/api'

/**
 * 内置编辑器打开着的那些文件。
 *
 * **这一片是只读的**，所以这里没有"脏"、没有"保存中"、没有冲突态 —— 一个文件要么
 * 正在读、要么读到了、要么读失败了，三个态。片 3 加上编辑之后会长出脏标记与保存态，
 * 但那时也**不会**变成 main 侧 RemoteEditEntry 那个 8 态状态机：那些态全都是为
 * "外部编辑器 + 文件监视 + 原子替换"存在的，内置编辑器一条都不需要。
 *
 * 正文（可达 2MB 的字符串）就放在 store 里，不另建缓存：它本来就是渲染进程独有的数据，
 * 而 zustand 的 set 是浅拷贝顶层，改 files 数组不会去复制那些字符串。
 */
export interface OpenFile {
  /** `sessionId::path`。会话 id 是 uuid，不含冒号，所以这个拼法不会撞 */
  key: string
  sessionId: SessionId
  /** 用户点开的那条路径（软链就是软链本身），标签与去重都用它 */
  path: string
  status: 'loading' | 'ready' | 'error'
  view?: RemoteFileView
  error?: string
  /** 当前用哪种编码解的。切编码 = 用新编码重读一次（远端零副作用，见 main 的 fileView） */
  charset: RemoteCharset
}

/**
 * 同时打开的上限。
 *
 * 有上限是因为每份正文最多 2MB，而 JS 字符串是 UTF-16 —— 十份就是 40MB 常驻。
 * 到上限**拒绝并说明**，不悄悄关掉最早那个：用户打开的标签被自动关掉是数据丢失的观感，
 * 哪怕这一片只读也一样（片 3 之后就真的是数据丢失了）。
 */
export const MAX_OPEN_VIEWS = 10

const keyOf = (sessionId: SessionId, path: string): string => `${sessionId}::${path}`

interface EditorStore {
  files: OpenFile[]
  /** 每个会话各自记住自己激活的是哪个文件 —— 切会话标签不该改变另一个会话的选择 */
  activeKey: Record<SessionId, string | undefined>
  open: (sessionId: SessionId, path: string) => Promise<void>
  setActive: (sessionId: SessionId, key: string) => void
  close: (key: string) => void
  /** 会话关闭时清掉它的全部文件。没有这一步就是 useMonitorStore.clear 那个泄漏的翻版 */
  closeSession: (sessionId: SessionId) => void
  reload: (key: string, charset?: RemoteCharset) => Promise<void>
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  files: [],
  activeKey: {},

  open: async (sessionId, path) => {
    const key = keyOf(sessionId, path)
    const existing = get().files.find((f) => f.key === key)
    // 已经开着就只是切过去。**不重读** —— 重读会把用户已经滚到的位置和折叠状态白扔掉，
    // 而"我想看看它变没变"有明确的入口（重新加载）
    if (existing) {
      set((s) => ({ activeKey: { ...s.activeKey, [sessionId]: key } }))
      return
    }
    if (get().files.length >= MAX_OPEN_VIEWS) {
      throw new Error(`同时打开的文件不能超过 ${MAX_OPEN_VIEWS} 个，请先关掉一些`)
    }

    set((s) => ({
      files: [...s.files, { key, sessionId, path, status: 'loading', charset: 'utf8' }],
      activeKey: { ...s.activeKey, [sessionId]: key }
    }))
    await get().reload(key)
  },

  setActive: (sessionId, key) => {
    set((s) => ({ activeKey: { ...s.activeKey, [sessionId]: key } }))
  },

  close: (key) => {
    set((s) => {
      const files = s.files.filter((f) => f.key !== key)
      const activeKey = { ...s.activeKey }
      for (const [sid, active] of Object.entries(activeKey)) {
        // 关掉的正好是激活项 → 落到同一会话里剩下的最后一个（没有就置空）
        if (active !== key) continue
        activeKey[sid] = files.filter((f) => f.sessionId === sid).at(-1)?.key
      }
      return { files, activeKey }
    })
  },

  closeSession: (sessionId) => {
    set((s) => {
      const activeKey = { ...s.activeKey }
      delete activeKey[sessionId]
      return { files: s.files.filter((f) => f.sessionId !== sessionId), activeKey }
    })
  },

  reload: async (key, charset) => {
    const target = get().files.find((f) => f.key === key)
    if (!target) return
    const useCharset = charset ?? target.charset

    const patch = (next: Partial<OpenFile>): void => {
      set((s) => ({ files: s.files.map((f) => (f.key === key ? { ...f, ...next } : f)) }))
    }
    patch({ status: 'loading', charset: useCharset, error: undefined })
    try {
      const view = await ofs.invoke('sftp:fileView', {
        sessionId: target.sessionId,
        path: target.path,
        charset: useCharset
      })
      // 读的过程中用户可能已经把这个标签关掉了 —— 那就别把它复活
      if (!get().files.some((f) => f.key === key)) return
      patch({ status: 'ready', view, error: undefined })
    } catch (err) {
      if (!get().files.some((f) => f.key === key)) return
      patch({ status: 'error', view: undefined, error: err instanceof Error ? err.message : String(err) })
    }
  }
}))

/** 某个会话打开着的文件（顺序即标签顺序） */
export function filesOfSession(files: OpenFile[], sessionId: SessionId): OpenFile[] {
  return files.filter((f) => f.sessionId === sessionId)
}
