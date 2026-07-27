import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  baseExtensions,
  languageConf,
  languageExtension,
  readOnlyConf,
  readOnlyExtension
} from './cmSetup'
import type { LanguageId } from './editorPolicy'
import styles from './EditorHost.module.css'

interface Props {
  /** 换 key = 换文件（或换编码重读）→ 整份 state 换掉 */
  fileKey: string
  text: string
  language: LanguageId
  readOnly: boolean
}

/**
 * CodeMirror 6 的容器。**整个渲染进程里唯一 new EditorView 的地方。**
 *
 * EditorView 只在挂载时建一次、卸载时销毁一次，中间靠 setState / 隔间 reconfigure 更新：
 * 每次换文件都重建的话，会话标签之间来回切一次就要重建一遍 —— 而 CM 的初始化要量字符宽度、
 * 建 gutter、跑第一遍语法解析，几十毫秒的抖动，在一个"实时响应"为卖点的面板上尤其难看。
 *
 * 换文件用 view.setState 而不是 dispatch 一个替换全文的事务：那样撤销历史会横跨两个文件，
 * 用户在 B 文件里按一次 Ctrl+Z 就能把 A 文件的内容"撤销"回来（片 3 可写之后是真事故）。
 */
export function CodeEditor({ fileKey, text, language, readOnly }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  const build = (doc: string): EditorState =>
    EditorState.create({
      doc,
      extensions: [
        ...baseExtensions(),
        languageConf.of(languageExtension(language)),
        readOnlyConf.of(readOnlyExtension(readOnly))
      ]
    })

  // 只建一次。依赖数组刻意为空 —— 下面几个 effect 负责把变化喂进去
  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({ parent: host.current, state: build(text) })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 换文件 / 换编码重读 → 换整份 state
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // 内容一致就不动：切回同一个文件、或 store 因为别的字段变化而重渲染时，
    // 白换一次 state 会把选区和折叠状态清掉
    if (view.state.doc.toString() === text) return
    view.setState(build(text))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, text])

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
