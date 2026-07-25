import { Plug, Rocket, History } from 'lucide-react'
import { Input } from 'antd'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '@/stores/useUiStore'
import styles from './WelcomePage.module.css'

/**
 * 无 tab 时的欢迎页。快速连接的解析与发起在 M1 接入（暂只做输入框壳）。
 */
export function WelcomePage(): React.JSX.Element {
  const { t } = useTranslation()
  const setEditingProfile = useUiStore((s) => s.setEditingProfile)

  return (
    <div className={styles.welcome}>
      <div className={styles.logo} />
      <div className={styles.title}>{t('welcome.title')}</div>
      <div className={styles.subtitle}>{t('welcome.subtitle')}</div>
      <div className={styles.cards}>
        <div className={styles.card} onClick={() => setEditingProfile('new')}>
          <div className={styles.cardTitle}>
            <Plug size={16} strokeWidth={1.75} />
            {t('welcome.newConnection')}
          </div>
          <div className={styles.cardDesc}>{t('welcome.newConnectionDesc')}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            <Rocket size={16} strokeWidth={1.75} />
            {t('welcome.quickConnect')}
          </div>
          <div className={styles.cardDesc}>
            <Input
              size="small"
              placeholder={t('welcome.quickConnectPlaceholder')}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            <History size={16} strokeWidth={1.75} />
            {t('welcome.recent')}
          </div>
          <div className={styles.cardDesc}>{t('welcome.noRecent')}</div>
        </div>
      </div>
    </div>
  )
}
