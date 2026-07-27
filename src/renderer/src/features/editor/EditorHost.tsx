import { useMemo } from 'react'
import { Button, Empty, Spin, Tooltip } from 'antd'
import { RefreshCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RemoteCharset } from '@shared/constants'
import { filesOfSession, useEditorStore } from '@/stores/useEditorStore'
import type { SessionTab } from '@/stores/useSessionStore'
import { CodeEditor } from './CodeEditor'
import { EditorStatusStrip } from './EditorStatusStrip'
import { resolveLanguage } from './editorPolicy'
import styles from './EditorHost.module.css'

interface Props {
  tab: SessionTab
}

/**
 * 会话内第三格：内置编辑器。
 *
 * 与 SFTP 面板并列而不是塞进它：一个文件被打开之后，用户接着要做的事是**在文件之间切**、
 * 而不是回到目录树 —— 把编辑器做成 SFTP 面板里的一个模式会让"看着 nginx.conf 顺手
 * 去翻旁边的 sites-enabled"变成来回切换。
 *
 * 只有真的打开过文件才占版面（SessionView 里按 files.length 决定这一格在不在）。
 */
export function EditorHost({ tab }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const files = useEditorStore((s) => s.files)
  const activeKey = useEditorStore((s) => s.activeKey[tab.sessionId ?? ''])
  const setActive = useEditorStore((s) => s.setActive)
  const close = useEditorStore((s) => s.close)
  const reload = useEditorStore((s) => s.reload)

  const mine = useMemo(() => filesOfSession(files, tab.sessionId ?? ''), [files, tab.sessionId])
  const active = mine.find((f) => f.key === activeKey) ?? mine[0]

  // 语言按**路径 + 首行**判，首行从已经读到的正文里切，不额外发请求
  const language = useMemo(
    () => (active ? resolveLanguage(active.path, active.view?.text.slice(0, 200) ?? '') : 'plain'),
    [active?.path, active?.view?.text]
  )

  if (mine.length === 0 || !active) {
    return (
      <div className={styles.host}>
        <div className={styles.empty}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('editor.emptyHint')} />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.host}>
      <div className={styles.tabs} role="tablist">
        {mine.map((f) => (
          <div
            key={f.key}
            role="tab"
            aria-selected={f.key === active.key}
            className={`${styles.tab} ${f.key === active.key ? styles.tabActive : ''}`}
            onClick={() => tab.sessionId && setActive(tab.sessionId, f.key)}
            // 中键关闭：这是标签条的通用手感，缺了会显得这个标签条是半成品
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                close(f.key)
              }
            }}
          >
            <Tooltip title={f.path}>
              <span className={styles.tabName}>{f.path.split('/').pop() || f.path}</span>
            </Tooltip>
            {f.status === 'loading' && <Spin size="small" className={styles.tabSpin} />}
            <X
              size={12}
              strokeWidth={2}
              className={styles.tabClose}
              onClick={(e) => {
                e.stopPropagation()
                close(f.key)
              }}
            />
          </div>
        ))}
        <span className={styles.tabsGap} />
        <Tooltip title={t('editor.reload')}>
          <Button
            size="small"
            type="text"
            icon={<RefreshCw size={13} strokeWidth={1.75} />}
            onClick={() => void reload(active.key)}
          />
        </Tooltip>
      </div>

      <div className={styles.body}>
        {active.status === 'error' ? (
          <div className={styles.empty}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span>
                  {active.error}
                  <br />
                  <a onClick={() => void reload(active.key)}>{t('common.retry')}</a>
                </span>
              }
            />
          </div>
        ) : active.view ? (
          <CodeEditor
            // 编码也进 key：换编码是"同一个文件的另一份解码结果"，
            // 让 CodeEditor 当成换文件处理（换整份 state）比在它内部分辨要简单
            fileKey={`${active.key}::${active.charset}`}
            text={active.view.text}
            language={language}
            readOnly
          />
        ) : (
          <div className={styles.empty}>
            <Spin />
          </div>
        )}
      </div>

      <EditorStatusStrip
        file={active}
        language={language}
        onCharset={(charset: RemoteCharset) => void reload(active.key, charset)}
      />
    </div>
  )
}
