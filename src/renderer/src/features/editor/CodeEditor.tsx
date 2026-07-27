import { useEffect, useRef, type MutableRefObject } from 'react'
import { EditorState, type Text } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  baseExtensions,
  languageConf,
  languageExtension,
  readOnlyConf,
  readOnlyExtension
} from './cmSetup'
import { planDraftSwap } from './draftSwap'
import type { LanguageId } from './editorPolicy'
import styles from './EditorHost.module.css'

interface Props {
  /** 换 key = 换文件（或换编码重读） */
  fileKey: string
  /** 上一次读到 / 存成的那份正文。**不是**编辑器里的当前内容，见下面 states 那段 */
  text: string
  language: LanguageId
  readOnly: boolean
  /** 当前还开着的全部 fileKey。用来清理草稿暂存，见 pruneStates */
  openKeys: string[]
  /** 内容与 `text` 是否不一致。每次文档变化、以及换文件之后各报一次 */
  onDirty: (fileKey: string, dirty: boolean) => void
  /** Ctrl+S。真正的保存流程在 EditorHost（要弹确认框），这里只负责把按键接出去 */
  onSave: (fileKey: string) => void
  /** 保存时从这里取当前正文。填的是一个 getter，不把正文推上去 —— 见下面那段 */
  docRef: MutableRefObject<(() => string) | null>
}

/**
 * 当前文档与基准是不是同一份内容。
 *
 * 顺序有讲究，而且这两步都是为了**别在按键路径上做 O(文档) 的活**：
 *  1. 基准不在（理论上不该发生）→ 当作脏，宁可多问一次也不许静默丢改动；
 *  2. `length` 先比（O(1)）—— 正常打字每一下都改长度，所以绝大多数按键在这里就返回了；
 *  3. 长度相同才 `Text.eq`（覆盖"选中一个字符打一个替换字符"这类同长度编辑），
 *     它在内容不同时会在第一个不同的块上短路。
 *
 * 提成纯函数是为了能在单测里对着它断言"没有 toString"（见 editorSave.test.ts 那条护栏）。
 */
function sameDoc(doc: Text, base: Text | undefined): boolean {
  if (!base) return false
  if (doc.length !== base.length) return false
  return doc.eq(base)
}

/**
 * CodeMirror 6 的容器。**整个渲染进程里唯一 new EditorView 的地方。**
 *
 * EditorView 只在挂载时建一次、卸载时销毁一次，中间靠 setState / 隔间 reconfigure 更新：
 * 每次换文件都重建的话，会话标签之间来回切一次就要重建一遍 —— 而 CM 的初始化要量字符宽度、
 * 建 gutter、跑第一遍语法解析，几十毫秒的抖动，在一个"实时响应"为卖点的面板上尤其难看。
 *
 * **正文不进 React 状态，也不进 store。** 受控组件那条路在这里是错的：doc 最大 2MB，
 * 每敲一个键复制一份字符串再重渲染整棵子树，是可感知的卡。所以 store 里存的是
 * "上一次读到/存成的那份"，当前内容只在 CM 自己的 state 里，需要时通过 `docRef` 取。
 */
export function CodeEditor({
  fileKey,
  text,
  language,
  readOnly,
  openKeys,
  onDirty,
  onSave,
  docRef
}: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** 当前 view 里装的是哪个文件。换文件时要先把旧的那份收好 */
  const mountedKey = useRef<string | null>(null)

  /**
   * 每个文件各自的 EditorState 暂存。
   *
   * 这一份暂存是**正确性要求**，不是优化：只有一个 view，换标签时如果直接
   * `setState(build(text))`，那么"改了 A → 切到 B → 切回 A"就会把 A 的未保存改动
   * 静默扔掉。顺带买到的是撤销历史与选区、折叠状态都跟着文件走 ——
   * 在 B 里按 Ctrl+Z 不会把 A 的内容撤销回来。
   *
   * `docBase` 记的是那份 state 当初是按哪个 `text` 建的：`text` 变了（重新加载、
   * 或者刚存成）就说明暂存过期，必须重建而不是恢复。
   */
  const states = useRef(new Map<string, EditorState>())
  const docBase = useRef(new Map<string, string>())
  /**
   * 与 docBase 同一份内容，但存成 CodeMirror 的 `Text`（rope）。**脏标记比的是这个。**
   *
   * 为什么要多存一份：脏标记每敲一个键都要判一次，而拿字符串判就得
   * `doc.toString()` —— 那是 O(整个文档) 的物化 + 比较，每次按键都付。实测（同一台机器，
   * 每按键的毫秒数）：1MB 1.8、4MB 6.0、8MB 7.4、16MB 7.8、32MB **14.3**。
   * 一帧只有 16ms，所以在大文件上这一下能自己吃掉一整帧。
   *
   * 换成 rope 之间比之后：先比 `length`（O(1)，实测 0.001ms），长度不同直接判脏；
   * 长度相同才 `Text.eq`，而它在**内容不同**时会在第一个不同的块上短路（实测 0.02–0.4ms）。
   * 只有"改动之后又恰好改回原样"那一次要真的走完全文（实测 8MB 28ms / 32MB 80ms）——
   * 那是一次性的，而且它换来的正是我们想要的语义：改一个字再改回来**不算脏**。
   *
   * `doc` 是从这份基准派生出来的，未改动的子树按引用共享，所以短路命中率极高。
   */
  const docBaseText = useRef(new Map<string, Text>())

  /** 用 ref 拿回调：keymap 在建 state 时就闭包进去了，直接用 props 会一直是第一次那份 */
  const onSaveRef = useRef(onSave)
  const onDirtyRef = useRef(onDirty)
  onSaveRef.current = onSave
  onDirtyRef.current = onDirty

  const build = (doc: string, key: string): EditorState =>
    EditorState.create({
      doc,
      extensions: [
        /**
         * Ctrl+S 放在最前面，**并且 preventDefault** —— Chromium 的"保存网页"就绑在
         * 这个键上，不拦住的话按一次会弹出系统的另存为对话框。
         *
         * 保存的键位只在编辑器有焦点时生效（keymap 挂在 CM 的 content 上），
         * 刻意**不做成全局快捷键**：Ctrl+S 在终端里是流控（XOFF），
         * 抢掉它会让 less / vim 用户莫名其妙。
         */
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current(key)
              return true
            }
          }
        ]),
        ...baseExtensions(),
        languageConf.of(languageExtension(language)),
        readOnlyConf.of(readOnlyExtension(readOnly)),
        /**
         * 脏标记。比的是"当前内容与建这份 state 时那份"，而不是"有没有编辑过"——
         * 用户改一个字再改回来，应该不算脏（否则关标签时白问他一次）。
         *
         * `docChanged` 时才比，所以移动光标、改选区、折叠都不触发。
         * 判定走 docBaseText（rope 比 rope，先短路长度），**不是** doc.toString()——
         * 后者是 O(整个文档)、每按键一次，理由与实测数字见 docBaseText 的注释。
         */
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return
          onDirtyRef.current(key, !sameDoc(u.state.doc, docBaseText.current.get(key)))
        })
      ]
    })

  // 只建一次。依赖数组刻意为空 —— 下面几个 effect 负责把变化喂进去
  useEffect(() => {
    if (!host.current) return
    const initial = build(text, fileKey)
    docBase.current.set(fileKey, text)
    docBaseText.current.set(fileKey, initial.doc)
    const view = new EditorView({ parent: host.current, state: initial })
    viewRef.current = view
    mountedKey.current = fileKey
    docRef.current = () => view.state.doc.toString()
    return () => {
      view.destroy()
      viewRef.current = null
      docRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 换文件 / 换编码重读 / 刚存成 → 按 planDraftSwap 的结论办。
   *
   * 三种结论各自的理由在 draftSwap.ts 里（那是纯函数，有一张用例表）——
   * 这里只负责照着做，并且**换文件之前先把旧的那份 state 收进暂存**。
   */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const prev = mountedKey.current
    const sameFile = prev === fileKey

    // 换文件：旧的那份必须先收好，否则它的草稿就没了
    if (!sameFile && prev) states.current.set(prev, view.state)

    const plan = planDraftSwap({
      prevKey: prev,
      fileKey,
      text,
      currentDoc: view.state.doc.toString(),
      hasStash: states.current.has(fileKey),
      stashBase: docBase.current.get(fileKey)
    })

    if (plan.kind === 'restore') {
      const stashed = states.current.get(fileKey)
      // planDraftSwap 说 restore 就一定有暂存；这个兜底只是不让类型收窄靠断言
      if (stashed) view.setState(stashed)
    } else if (plan.kind === 'rebuild') {
      const next = build(text, fileKey)
      docBase.current.set(fileKey, text)
      docBaseText.current.set(fileKey, next.doc)
      view.setState(next)
    } else {
      /**
       * keep：内容已经等于 text（刚存成的那一下）。**基准要换成当前那份 doc**，
       * 不是重新按 text 造一个 Text —— 换成当前 doc 之后，后续按键得到的文档都从它派生，
       * 未改动的子树按引用共享，Text.eq 的短路才生效。
       */
      docBase.current.set(fileKey, text)
      docBaseText.current.set(fileKey, view.state.doc)
    }

    mountedKey.current = fileKey
    onDirtyRef.current(fileKey, !sameDoc(view.state.doc, docBaseText.current.get(fileKey)))
    // 恢复暂存之后 CM 需要重新量一次几何：这一格在切换期间尺寸可能变过
    if (!sameFile) view.requestMeasure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, text])

  /**
   * 清掉已经关掉的文件的暂存。这一条也是**正确性要求**：
   * fileKey 是 `sessionId::path::charset`，关掉再重新打开同一个文件会得到同一个 key ——
   * 不清的话，用户"关掉标签放弃改动"之后再打开，草稿会诡异地复活。
   */
  useEffect(() => {
    const live = new Set(openKeys)
    for (const key of [...states.current.keys()]) {
      if (live.has(key)) continue
      states.current.delete(key)
      docBase.current.delete(key)
      docBaseText.current.delete(key)
    }
  }, [openKeys])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageConf.reconfigure(languageExtension(language))
    })
  }, [language])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: readOnlyConf.reconfigure(readOnlyExtension(readOnly)) })
    // 只读时藏掉插入符（CSS 在 cmSetup 的主题里）。用 data 属性而不是加类名：
    // CM 自己会重写 .cm-editor 的 className，加上去的类名会被它覆盖掉
    view.dom.dataset.ofsReadonly = readOnly ? '1' : '0'
  }, [readOnly])

  return <div ref={host} className={styles.cm} />
}
