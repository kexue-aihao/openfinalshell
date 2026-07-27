import { useCallback, useMemo, useRef } from 'react'
import { App as AntdApp, Button, Empty, Spin, Tooltip, Typography } from 'antd'
import { RefreshCw, Save, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RemoteCharset } from '@shared/constants'
import type { RemoteFileSaveResult, RemoteSaveGates } from '@shared/types'
import { filesOfSession, NO_GATES, useEditorStore } from '@/stores/useEditorStore'
import type { SessionTab } from '@/stores/useSessionStore'
import { CodeEditor } from './CodeEditor'
import { EditorStatusStrip } from './EditorStatusStrip'
import { resolveLanguage } from './editorPolicy'
import styles from './EditorHost.module.css'

interface Props {
  tab: SessionTab
}

/**
 * 三个闸门各自的文案与要打开的那个开关。
 *
 * 一个闸门一次确认、一次只打开被确认的那一个 —— 这是 main 侧把 `SaveGates` 拆成
 * 三个必填 boolean 的全部意义（老路一个 `force` 会让"仍然覆盖"顺带放行非原子替换）。
 * 所以这张表里 gate 与 kind 是一对一的，不许出现一条确认打开两个开关。
 */
const GATE_OF: Record<
  Exclude<RemoteFileSaveResult['kind'], 'saved'>,
  { gate: keyof RemoteSaveGates; title: string; desc: string; okText: string; danger: boolean }
> = {
  conflict: {
    gate: 'overwriteRemoteChanges',
    title: 'editor.conflictTitle',
    desc: 'editor.conflictDesc',
    okText: 'editor.conflictOk',
    danger: true
  },
  nonAtomic: {
    gate: 'allowNonAtomic',
    title: 'editor.nonAtomicTitle',
    desc: 'editor.nonAtomicDesc',
    okText: 'editor.nonAtomicOk',
    danger: false
  },
  shrink: {
    gate: 'allowShrink',
    title: 'editor.shrinkTitle',
    desc: 'editor.shrinkDesc',
    okText: 'editor.shrinkOk',
    danger: true
  }
}

/**
 * 会话内第三格：内置编辑器。
 *
 * 与 SFTP 面板并列而不是塞进它：一个文件被打开之后，用户接着要做的事是**在文件之间切**、
 * 而不是回到目录树 —— 把编辑器做成 SFTP 面板里的一个模式会让"看着 nginx.conf 顺手
 * 去翻旁边的 sites-enabled"变成来回切换。
 *
 * 只有真的打开过文件才占版面（SessionView 里按 files.length 决定这一格在不在）。
 *
 * **保存的编排在这里，不在 store**：三个确认框需要 antd 的 modal 上下文与 i18n，
 * 而 store 要能在 jsdom 里直接测。store 只负责发出去、把结果与新状态记下来。
 */
export function EditorHost({ tab }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { message, modal } = AntdApp.useApp()
  const files = useEditorStore((s) => s.files)
  const activeKey = useEditorStore((s) => s.activeKey[tab.sessionId ?? ''])
  const setActive = useEditorStore((s) => s.setActive)
  const closeFile = useEditorStore((s) => s.close)
  const reload = useEditorStore((s) => s.reload)
  const setDirty = useEditorStore((s) => s.setDirty)
  const save = useEditorStore((s) => s.save)

  /** CodeEditor 填进来的"取当前正文"。正文不进 store，见 CodeEditor 里那段 */
  const docRef = useRef<(() => string) | null>(null)

  const mine = useMemo(() => filesOfSession(files, tab.sessionId ?? ''), [files, tab.sessionId])
  const active = mine.find((f) => f.key === activeKey) ?? mine[0]

  /** CodeEditor 的 fileKey：编码也进去，换编码 = 同一个文件的另一份解码结果 */
  const fileKeyOf = (f: { key: string; charset: RemoteCharset }): string => `${f.key}::${f.charset}`
  const openKeys = useMemo(() => mine.map(fileKeyOf), [mine])

  // 语言按**路径 + 首行**判，首行从已经读到的正文里切，不额外发请求
  const language = useMemo(
    () => (active ? resolveLanguage(active.path, active.view?.text.slice(0, 200) ?? '') : 'plain'),
    [active?.path, active?.view?.text]
  )

  /**
   * 保存一次。闸门被拦下时弹对应的确认框，用户点了就**只**把那一个开关打开再来一次。
   *
   * 递归天然有界：每一轮最多把一个 false 变成 true，三个开关全开之后 main 只可能
   * 回 saved 或抛错。那个"同一个 kind 又回来了"的分支是防 main 侧出错的兜底 ——
   * 没有它，一个逻辑错误会变成一个关不掉的确认框。
   */
  const doSave = useCallback(
    async (key: string, gates: RemoteSaveGates): Promise<void> => {
      const text = docRef.current?.()
      if (text === undefined) return
      const file = useEditorStore.getState().files.find((f) => f.key === key)
      if (!file) return

      let result: RemoteFileSaveResult
      try {
        result = await save(key, gates, text)
      } catch (err) {
        /**
         * 硬拒都走到这里（编码存不下去、原字节解不干净、超上限、基线不在、
         * 路径指向变了）。**没有任何确认能越过它们**，所以这里只报不问。
         * 用 modal.error 而不是 message.error：这些原话有具体的下一步动作
         * （"删掉这些字符""换个编码重新打开"），一闪而过的 toast 读不完。
         * （原话是 main 侧硬编码的中文，沿用既有约定，不进 t()）
         */
        modal.error({
          title: t('editor.saveFailed'),
          width: 520,
          content: (
            <div className={styles.decision}>
              <Typography.Text code>{file.path}</Typography.Text>
              <Typography.Text type="secondary">
                {err instanceof Error ? err.message : String(err)}
              </Typography.Text>
            </div>
          )
        })
        return
      }

      if (result.kind === 'saved') {
        message.success(
          result.warning
            ? t('editor.savedWithWarning', { warning: result.warning })
            : t('editor.saved')
        )
        return
      }

      const spec = GATE_OF[result.kind]
      if (gates[spec.gate]) {
        // 开关已经开着却又回同一个 kind：只可能是 main 侧的逻辑错，别再弹框了
        message.error(t('editor.gateStuck'))
        return
      }

      modal.confirm({
        title: t(spec.title),
        width: 520,
        keyboard: false,
        maskClosable: false,
        okText: t(spec.okText),
        okType: spec.danger ? 'danger' : 'primary',
        cancelText: t('common.cancel'),
        /**
         * 两个危险分支不给默认焦点：conflict 会盖掉别人的改动，shrink 会把文件
         * 截成一小截 —— 顺手一个回车不该等于按下它。nonAtomic 只是"多一个短暂窗口"，
         * 沿用 antd 的默认焦点。
         */
        autoFocusButton: spec.danger ? null : 'ok',
        content: (
          <div className={styles.decision}>
            <Typography.Text code>{file.path}</Typography.Text>
            <span>{t(spec.desc)}</span>
            {/* main 给的实数与原话：conflict 分"远端没了"和"被改过"两种，
                shrink 那句里带着"从 X 字节变成 Y 字节" —— 都是用户裁决真正要看的东西
                （main 侧硬编码中文，沿用既有约定不进 t()） */}
            {result.kind === 'conflict' && (
              <Typography.Text type="secondary">{result.reason}</Typography.Text>
            )}
            {result.kind === 'shrink' && (
              <Typography.Text type="warning">
                {t('editor.shrinkNumbers', {
                  remote: result.remoteBytes,
                  local: result.localBytes
                })}
              </Typography.Text>
            )}
          </div>
        ),
        onOk: () => doSave(key, { ...gates, [spec.gate]: true })
      })
    },
    [save, modal, message, t]
  )

  const onSaveKey = useCallback((fileKey: string) => {
    // CodeEditor 给的是带编码后缀的 fileKey，剥回 store 的 key
    const key = fileKey.slice(0, fileKey.lastIndexOf('::'))
    void doSave(key, NO_GATES)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doSave])

  const onDirty = useCallback(
    (fileKey: string, dirty: boolean) => {
      setDirty(fileKey.slice(0, fileKey.lastIndexOf('::')), dirty)
    },
    [setDirty]
  )

  /**
   * 脏文件上的破坏性操作先问一句。三个入口共用这一个：关标签、重新加载、换编码 ——
   * 三者都会让编辑器里那份内容消失，而"我改了半小时"和"我随手点了个按钮"
   * 在界面上看不出区别。
   */
  const confirmDiscard = useCallback(
    (path: string, onOk: () => void): void => {
      modal.confirm({
        title: t('editor.discardTitle'),
        width: 460,
        okText: t('editor.discardOk'),
        okType: 'danger',
        cancelText: t('common.cancel'),
        autoFocusButton: null,
        content: (
          <div className={styles.decision}>
            <Typography.Text code>{path}</Typography.Text>
            <span>{t('editor.discardDesc')}</span>
          </div>
        ),
        onOk
      })
    },
    [modal, t]
  )

  const tryClose = useCallback(
    (key: string): void => {
      const f = useEditorStore.getState().files.find((x) => x.key === key)
      if (!f) return
      if (!f.dirty) {
        closeFile(key)
        return
      }
      confirmDiscard(f.path, () => closeFile(key))
    },
    [closeFile, confirmDiscard]
  )

  const tryReload = useCallback(
    (key: string, charset?: RemoteCharset): void => {
      const f = useEditorStore.getState().files.find((x) => x.key === key)
      if (!f) return
      if (!f.dirty) {
        void reload(key, charset)
        return
      }
      confirmDiscard(f.path, () => void reload(key, charset))
    },
    [reload, confirmDiscard]
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

  /**
   * 什么时候仍然只读：
   *  - 还没读完 / 读失败（没有内容可改）；
   *  - `lossless` 为假 —— 当前编码解不干净，保存必然改写用户从没看见过的字节。
   *    main 那侧本来就会硬拒，但界面**不能**让用户先改二十分钟再被拒。
   */
  const readOnly = active.status !== 'ready' || !active.view || !active.view.lossless
  const canSave = !readOnly && !active.saving

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
                tryClose(f.key)
              }
            }}
          >
            <Tooltip title={f.path}>
              <span className={styles.tabName}>{f.path.split('/').pop() || f.path}</span>
            </Tooltip>
            {/* 未保存的点。放在名字后面而不是替掉关闭按钮：那种做法要用户先 hover
                才知道能不能关，而"有没有改动"是他随时都该看得见的一件事 */}
            {f.dirty && (
              <Tooltip title={t('editor.dirtyHint')}>
                <span className={styles.tabDirty} data-ofs-dirty="1" />
              </Tooltip>
            )}
            {(f.status === 'loading' || f.saving) && <Spin size="small" className={styles.tabSpin} />}
            <X
              size={12}
              strokeWidth={2}
              className={styles.tabClose}
              onClick={(e) => {
                e.stopPropagation()
                tryClose(f.key)
              }}
            />
          </div>
        ))}
        <span className={styles.tabsGap} />
        <Tooltip title={t('editor.saveHint')}>
          <Button
            size="small"
            type="text"
            disabled={!canSave}
            loading={active.saving}
            icon={<Save size={13} strokeWidth={1.75} />}
            data-ofs-save="1"
            onClick={() => void doSave(active.key, NO_GATES)}
          />
        </Tooltip>
        <Tooltip title={t('editor.reload')}>
          <Button
            size="small"
            type="text"
            icon={<RefreshCw size={13} strokeWidth={1.75} />}
            onClick={() => tryReload(active.key)}
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
                  <a onClick={() => tryReload(active.key)}>{t('common.retry')}</a>
                </span>
              }
            />
          </div>
        ) : active.view ? (
          <CodeEditor
            fileKey={fileKeyOf(active)}
            text={active.view.text}
            language={language}
            readOnly={readOnly}
            openKeys={openKeys}
            onDirty={onDirty}
            onSave={onSaveKey}
            docRef={docRef}
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
        readOnly={readOnly}
        onCharset={(charset: RemoteCharset) => tryReload(active.key, charset)}
      />
    </div>
  )
}
