import { Select, Tag, Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import { REMOTE_CHARSETS, type RemoteCharset } from '@shared/constants'
import { formatBytes, modeToOctal } from '@/utils/format'
import { languageLabel, type LanguageId } from './editorPolicy'
import type { OpenFile } from '@/stores/useEditorStore'
import styles from './EditorWindowShell.module.css'

interface Props {
  file: OpenFile
  language: LanguageId
  /** 由 EditorWindowShell 判定（读没读完 + lossless），这里只负责把**为什么**说清楚 */
  readOnly: boolean
  onCharset: (charset: RemoteCharset) => void
}

/**
 * 底部状态条。它是这一片里**信息密度最高**的地方，因为一份远端文本文件有四件事
 * 用户不看就不知道、而看错了会毁文件：编码、行尾、有没有 BOM、以及权限位。
 *
 * 编码是个下拉框而不是只读展示：`lossless` 判不出"编码猜对了没有"
 * （UTF-8 的中文按 GBK 解也是合法 GBK，见 main/sftp/textCodec.ts），所以最终只能靠
 * 用户看一眼是不是乱码、然后换一个。换编码 = 用新编码重读一次，远端零副作用。
 */
export function EditorStatusStrip({
  file,
  language,
  readOnly,
  onCharset
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const view = file.view

  return (
    <div className={styles.status}>
      <Tooltip title={view && view.resolvedPath !== view.requestedPath ? view.resolvedPath : file.path}>
        <span className={styles.statusPath}>
          {file.path}
          {/* 软链：显示"→ 真身"。用户点的是软链，读写的是真身，这件事必须看得见 */}
          {view && view.resolvedPath !== view.requestedPath && (
            <span className={styles.statusLink}> → {view.resolvedPath}</span>
          )}
        </span>
      </Tooltip>

      <span className={styles.statusGap} />

      {view && (
        <>
          {!view.lossless && (
            <Tooltip title={t('editor.losslessHint')}>
              <Tag color="warning" className={styles.statusTag}>
                {t('editor.lossless')}
              </Tag>
            </Tooltip>
          )}
          {view.mixedEol && (
            <Tooltip title={t('editor.mixedEolHint')}>
              <Tag color="warning" className={styles.statusTag}>
                {t('editor.mixedEol')}
              </Tag>
            </Tooltip>
          )}
          {file.dirty && (
            <Tooltip title={t('editor.dirtyHint')}>
              <Tag color="processing" className={styles.statusTag}>
                {t('editor.dirty')}
              </Tag>
            </Tooltip>
          )}
          {/* 只读时必须说清**为什么**：这一版里唯一的成因是"当前编码解不干净"，
              而那个 Tag 已经在左边亮着了 —— 两个连起来读才是一句完整的话 */}
          {readOnly && (
            <Tooltip title={view.lossless ? t('editor.readOnlyHint') : t('editor.readOnlyLossless')}>
              <Tag className={styles.statusTag}>{t('editor.readOnly')}</Tag>
            </Tooltip>
          )}

          <span className={styles.statusItem}>{languageLabel(language)}</span>

          <Tooltip title={t('editor.charsetHint')}>
            <Select<RemoteCharset>
              size="small"
              variant="borderless"
              value={file.charset}
              onChange={onCharset}
              className={styles.charset}
              options={REMOTE_CHARSETS.map((c) => ({ value: c, label: c }))}
            />
          </Tooltip>

          <span className={styles.statusItem}>{view.eol === 'crlf' ? 'CRLF' : 'LF'}</span>
          {view.hasBom && (
            <Tooltip title={t('editor.bomHint')}>
              <span className={styles.statusItem}>BOM</span>
            </Tooltip>
          )}
          <span className={styles.statusItem}>{formatBytes(view.bytes)}</span>
          <Tooltip title={t('editor.modeHint')}>
            <span className={styles.statusItem}>{modeToOctal(view.mode)}</span>
          </Tooltip>
        </>
      )}
    </div>
  )
}
