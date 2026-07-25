import { useState } from 'react'
import { App as AntdApp, Input } from 'antd'
import { History, Plug, Rocket, Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProfileDraft } from '@shared/types'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUiStore } from '@/stores/useUiStore'
import styles from './WelcomePage.module.css'

/** 解析 `ssh user@host[:port]` / `user@host` / `host` 三种写法 */
export function parseQuickConnect(input: string): { username: string; host: string; port: number } | null {
  const s = input.trim().replace(/^ssh\s+/i, '')
  if (!s) return null
  const m = /^(?:([^@\s]+)@)?([^:\s]+)(?::(\d{1,5}))?$/.exec(s)
  if (!m) return null
  const port = m[3] ? Number(m[3]) : 22
  if (port < 1 || port > 65535) return null
  return { username: m[1] || 'root', host: m[2], port }
}

export function WelcomePage(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const setEditingProfile = useUiStore((s) => s.setEditingProfile)
  const { profiles, save } = useConnectionStore()
  const openForProfile = useSessionStore((s) => s.openForProfile)
  const [quick, setQuick] = useState('')

  const recent = [...profiles]
    .filter((p) => p.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, 8)

  const doQuickConnect = async (): Promise<void> => {
    const parsed = parseQuickConnect(quick)
    if (!parsed) {
      message.error(t('welcome.quickConnectInvalid'))
      return
    }
    // 快速连接落成一条真实配置（无密码 → 连接时询问），便于后续复用
    const draft: ProfileDraft = {
      name: `${parsed.username}@${parsed.host}`,
      groupId: null,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      auth: { method: 'password' },
      terminal: { charset: 'utf-8', termType: 'xterm-256color' },
      options: {
        keepaliveInterval: 15000,
        readyTimeout: 15000,
        legacyAlgorithms: false,
        autoReconnect: true,
        monitorEnabled: true,
        compress: false
      }
    }
    const profile = await save(draft)
    setQuick('')
    await openForProfile(profile)
  }

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
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              onPressEnter={() => void doQuickConnect()}
            />
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardTitle}>
            <History size={16} strokeWidth={1.75} />
            {t('welcome.recent')}
          </div>
          <div className={styles.cardDesc}>
            {recent.length === 0 ? (
              t('welcome.noRecent')
            ) : (
              <div className={styles.recentList}>
                {recent.map((p) => (
                  <div
                    key={p.id}
                    className={styles.recentItem}
                    onClick={() => void openForProfile(p)}
                  >
                    <Server size={12} strokeWidth={1.75} />
                    <span className={styles.recentName}>{p.name}</span>
                    <span className={styles.recentHost}>
                      {p.username}@{p.host}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
