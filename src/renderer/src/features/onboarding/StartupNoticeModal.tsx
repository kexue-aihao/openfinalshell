import { useEffect, useState } from 'react'
import { Divider, Modal, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type { StartupNotice } from '@shared/types'
import { ofs } from '@/ipc/api'
import { SHORTCUTS } from '@/features/settings/shortcuts'
import { notesSince, type ReleaseNote } from './releaseNotes'
import styles from './StartupNoticeModal.module.css'

/**
 * 开机弹窗：全新安装弹"功能 + 快捷键"引导；增量更新弹"更新了什么"。
 * 弹哪种由 main 的 app:getStartupNotice 决定（它首次被问到就把当前版本记为已见，
 * 所以同一版本只弹一次）。kind==='none' 不渲染。
 */
export function StartupNoticeModal(): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [notice, setNotice] = useState<StartupNotice | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    ofs
      .invoke('app:getStartupNotice')
      .then((n) => {
        if (!alive) return
        setNotice(n)
        if (n.kind !== 'none') setOpen(true)
      })
      .catch(() => {}) // 拿不到就当没有，绝不因为一个提示窗把启动卡住
    return () => {
      alive = false
    }
  }, [])

  if (!notice || notice.kind === 'none') return null
  const isFresh = notice.kind === 'fresh'

  return (
    <Modal
      open={open}
      title={
        isFresh
          ? t('onboarding.welcomeTitle')
          : t('onboarding.whatsNewTitle', { version: notice.toVersion })
      }
      onOk={() => setOpen(false)}
      onCancel={() => setOpen(false)}
      okText={isFresh ? t('onboarding.getStarted') : t('onboarding.gotIt')}
      cancelButtonProps={{ style: { display: 'none' } }}
      width={560}
      maskClosable={false}
    >
      <div className={styles.body}>
        {isFresh ? (
          <FreshContent />
        ) : (
          <UpdateContent notice={notice} zh={i18n.language.startsWith('zh')} />
        )}
      </div>
    </Modal>
  )
}

function FreshContent(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <Typography.Paragraph type="secondary">{t('onboarding.welcomeIntro')}</Typography.Paragraph>
      <div className={styles.sectionTitle}>{t('onboarding.featuresTitle')}</div>
      {/* 静态引用（不用模板拼 key）：i18n 检查器只认写死的 key 字面量，动态拼的会被判为未使用 */}
      <ul className={styles.featureList}>
        <li>{t('onboarding.featureTerminal')}</li>
        <li>{t('onboarding.featureSftp')}</li>
        <li>{t('onboarding.featureMonitor')}</li>
        <li>{t('onboarding.featureManage')}</li>
      </ul>
      <Divider style={{ margin: '12px 0' }} />
      <div className={styles.sectionTitle}>{t('onboarding.shortcutsTitle')}</div>
      <table className={styles.shortcuts}>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.keys}>
              <td>
                <kbd className={styles.kbd}>{s.keys}</kbd>
              </td>
              <td>{t(s.descKey)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function UpdateContent({
  notice,
  zh
}: {
  notice: StartupNotice
  zh: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const notes: ReleaseNote[] = notesSince(notice.fromVersion, notice.toVersion)

  const openReleases = (): void => {
    void ofs
      .invoke('app:openExternal', 'https://github.com/openfinalshell/openfinalshell/releases')
      .catch(() => {})
  }

  return (
    <>
      {notice.fromVersion && (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {t('onboarding.updatedFromTo', { from: notice.fromVersion, to: notice.toVersion })}
        </Typography.Paragraph>
      )}
      {notes.length === 0 ? (
        <Typography.Paragraph type="secondary">{t('onboarding.noNotes')}</Typography.Paragraph>
      ) : (
        notes.map((n) => (
          <div key={n.version} className={styles.noteBlock}>
            {notes.length > 1 && <div className={styles.noteVersion}>v{n.version}</div>}
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
        ))
      )}
      <Divider style={{ margin: '12px 0 8px' }} />
      <a onClick={openReleases}>{t('onboarding.viewReleases')}</a>
    </>
  )
}
