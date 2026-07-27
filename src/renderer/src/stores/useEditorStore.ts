import { create } from 'zustand'
import type { RemoteCharset } from '@shared/constants'
import type { RemoteFileSaveResult, RemoteFileView, RemoteSaveGates, SessionId } from '@shared/types'
import { ofs } from '@/ipc/api'

/**
 * 内置编辑器打开着的那些文件。
 *
 * 一个文件的态很少：正在读 / 读到了 / 读失败了，外加两个布尔（脏、正在存）。
 * 刻意**不**长成 main 侧 RemoteEditEntry 那个 8 态状态机 —— 那些态全都是为
 * "外部编辑器 + 文件监视 + 原子替换的能力探测"存在的，内置编辑器一条都不需要：
 * 内容一直在自己手里，保存是一次 invoke，结果只有四种。
 *
 * 正文（可达 2MB 的字符串）就放在 store 里，不另建缓存：它本来就是渲染进程独有的数据，
 * 而 zustand 的 set 是浅拷贝顶层，改 files 数组不会去复制那些字符串。
 *
 * ⚠️ **正在编辑中的草稿不在这里**，在 CodeMirror 自己的 state 里。理由是性能：
 * 把 doc 每敲一个键就推进 store，等于每次按键复制一份最多 2MB 的字符串、
 * 再让整棵编辑器子树重渲染一次。store 里的 `view.text` 是**上一次读到/存成的那份**，
 * 脏与否靠 CodeEditor 比出来告诉这里（见 setDirty）。
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
  /** 编辑器里的内容与 `view.text` 不一致。关标签、关会话、重新加载都要看它 */
  dirty: boolean
  /** 正在存。按钮转圈用，也顺手挡住界面层的重复提交（main 侧另有一道 in-flight 拒绝） */
  saving: boolean
}

/**
 * 三个闸门的初始值：**全关**。
 *
 * 每一个都只能由"用户看过那一条风险并点了确认"打开，而且只打开被确认的那一个 ——
 * 所以这个对象是每次保存的起点，逐个 gate 由 saveWith 往上叠。
 */
export const NO_GATES: RemoteSaveGates = {
  overwriteRemoteChanges: false,
  allowNonAtomic: false,
  allowShrink: false
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
  /** CodeEditor 比出来的脏状态。只改这一个字段，不碰正文 */
  setDirty: (key: string, dirty: boolean) => void
  /**
   * 保存。`gates` 由调用方逐个叠加 —— 每一个都必须对应一次用户确认过的风险。
   *
   * 返回 main 侧那四种结果原样交给调用方：**这一层不弹任何对话框**。
   * 弹框归 EditorHost（它才有 antd 的 modal 上下文与 i18n），store 只管
   * "把内容发出去、把结果和新状态记下来"。这样 store 可以在 jsdom 里直接测，
   * 而不需要去 mock 一个 Modal。
   */
  save: (key: string, gates: RemoteSaveGates, text: string) => Promise<RemoteFileSaveResult>
  /** 某个会话下有没有未保存的改动（关会话前要问一句） */
  hasDirty: (sessionId: SessionId) => boolean
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
      files: [
        ...s.files,
        { key, sessionId, path, status: 'loading', charset: 'utf8', dirty: false, saving: false }
      ],
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
      // 重读之后编辑器会被换成这份新内容，所以脏标记一定要跟着清 ——
      // 留着的话标签上会一直挂着那个点，而且关标签时白问一次"要放弃改动吗"
      patch({ status: 'ready', view, error: undefined, dirty: false })
    } catch (err) {
      if (!get().files.some((f) => f.key === key)) return
      patch({ status: 'error', view: undefined, error: err instanceof Error ? err.message : String(err) })
    }
  },

  setDirty: (key, dirty) => {
    set((s) => ({
      // 值没变就返回原数组：这个函数会被每次按键调到，
      // 每次都造一个新数组等于让整格编辑器跟着重渲染
      files: s.files.some((f) => f.key === key && f.dirty !== dirty)
        ? s.files.map((f) => (f.key === key ? { ...f, dirty } : f))
        : s.files
    }))
  },

  save: async (key, gates, text) => {
    const target = get().files.find((f) => f.key === key)
    if (!target) throw new Error('这个文件已经关掉了')
    if (!target.view) throw new Error('文件还没读完，稍后再存')

    const patch = (next: Partial<OpenFile>): void => {
      set((s) => ({ files: s.files.map((f) => (f.key === key ? { ...f, ...next } : f)) }))
    }
    patch({ saving: true })
    try {
      /**
       * charset / eol / hasBom 三个都从**当前那份 view** 取，一个都不省。
       * 缺任何一个都会静默改写文件（GBK 存成 UTF-8、CRLF 整个翻面、
       * 替用户删掉 .bat 的 BOM），三者都不报错，见 shared/ipc.ts 里那段。
       */
      const result = await ofs.invoke('sftp:fileSave', {
        sessionId: target.sessionId,
        path: target.path,
        text,
        charset: target.charset,
        eol: target.view.eol,
        hasBom: target.view.hasBom,
        gates
      })

      // 存的过程中标签被关掉了：结果照样返回给调用方（它要报错/提示），但不复活这条记录
      if (!get().files.some((f) => f.key === key)) return result

      if (result.kind === 'saved') {
        /**
         * 存成了：把 `view` 更新成刚写上去的那份。
         *
         * 必须更新 `text`，否则编辑器里的内容与 store 里的对不上，脏标记会立刻又亮起来。
         * `bytes` / `mode` 用 main 回来的实测值而不是自己算：编码之后的长度只有 main 知道。
         * `lossless` 置真 —— 远端那份字节就是刚从这个字符串编出来的。
         * `mixedEol` 置假：保存已经把整个文件的行尾统一掉了，那条警告不再适用。
         */
        patch({
          saving: false,
          dirty: false,
          view: {
            ...target.view,
            text,
            bytes: result.bytes,
            mode: result.mode,
            lossless: true,
            mixedEol: false
          }
        })
      } else {
        // 三个闸门：一个字节都没写，什么都不改（包括脏标记 —— 内容确实还没上去）
        patch({ saving: false })
      }
      return result
    } catch (err) {
      if (get().files.some((f) => f.key === key)) patch({ saving: false })
      throw err
    }
  },

  hasDirty: (sessionId) => get().files.some((f) => f.sessionId === sessionId && f.dirty)
}))

/** 某个会话打开着的文件（顺序即标签顺序） */
export function filesOfSession(files: OpenFile[], sessionId: SessionId): OpenFile[] {
  return files.filter((f) => f.sessionId === sessionId)
}
