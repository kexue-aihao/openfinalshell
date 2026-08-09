import { useTranslation } from 'react-i18next'
import { DONATE_METHODS } from './donations'
import styles from './DonateSection.module.css'

/**
 * 赞赏支持区块（设置→关于）。展示各收款方式的二维码，纯图片，不接任何支付接口。
 */
export function DonateSection(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className={styles.wrap}>
      <div className={styles.title}>{t('donate.title')}</div>
      <div className={styles.subtitle}>{t('donate.subtitle')}</div>
      <div className={styles.grid}>
        {DONATE_METHODS.map((m) => (
          <div key={m.id} className={styles.tile}>
            {/* 币种 + 作用（链/用途）显示在二维码上方 */}
            <div className={styles.label}>
              <span className={styles.coin}>{m.label}</span>
              <span className={styles.note}>{m.note}</span>
            </div>
            <div className={styles.qr}>
              <img src={m.img} alt={`${m.label} ${m.note}`} draggable={false} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
