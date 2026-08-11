import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import EditorWindowApp from './EditorWindowApp'
import './i18n'
import './styles/global.css'

/**
 * 两个 BrowserWindow 共用同一份 renderer bundle，按 URL hash 分流：
 * 主窗口不带 hash，独立编辑器窗口由 main 以 `#/editor` 打开（见 editorWindow.ts）。
 * 用 hash 而不是 query 是因为打包后走 loadFile，hash 是它唯一原生支持的定位方式。
 */
const isEditorWindow = window.location.hash.startsWith('#/editor')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isEditorWindow ? <EditorWindowApp /> : <App />}
  </React.StrictMode>
)
