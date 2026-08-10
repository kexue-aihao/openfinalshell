import { Modal, Tag } from 'antd'
import { useTranslation } from 'react-i18next'
import { RELEASE_NOTES } from './releaseNotes'
import styles from './StartupNoticeModal.module.css'

/**
 * 历史更新日志。列出 RELEASE_NOTES 里的全部版本（新→旧），从设置→关于打开。
 * 与开机更新弹窗共用同一份数据与样式；文案走 releaseNotes 的 zh/en 双语通道
 * （非中英回退英文，与 StartupNoticeModal 一致）。
 */
export function ChangelogModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  return (
    <Modal
      open={open}
      title={t('settings.changelog')}
      onOk={onClose}
      onCancel={onClose}
      okText={t('onboarding.gotIt')}
      cancelButtonProps={{ style: { display: 'none' } }}
      width={560}
    >
      <div className={styles.body}>
        {RELEASE_NOTES.map((n) => (
          <div key={n.version} className={styles.noteBlock}>
            <div className={styles.noteVersion}>v{n.version}</div>
            <ul className={styles.noteList}>
              {n.items.map((it, i) => (
                <li key={i}>
                  <Tag color={it.type === 'fix' ? 'orange' : 'blue'} className={styles.noteTag}>
                    {it.type === 'fix' ? t('onboarding.typeFix') : t('onboarding.typeFeat')}
                  </Tag>
                  <span>{zh ? it.zh : it.en}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  )
}
