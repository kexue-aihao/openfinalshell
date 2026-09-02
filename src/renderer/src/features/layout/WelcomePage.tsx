import { useState } from 'react'
import { App as AntdApp, Button, Input } from 'antd'
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
  const launchProfile = useSessionStore((s) => s.launchProfile)
  const [quick, setQuick] = useState('')
  const [quickConnecting, setQuickConnecting] = useState(false)
  const [quickError, setQuickError] = useState<string | null>(null)

  const recent = [...profiles]
    .filter((p) => p.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, 8)

  const doQuickConnect = async (): Promise<void> => {
    if (quickConnecting) return
    if (!quick.trim()) return
    const parsed = parseQuickConnect(quick)
    if (!parsed) {
      const error = t('welcome.quickConnectInvalid')
      setQuickError(error)
      message.error(error)
      return
    }
    setQuickError(null)
    setQuickConnecting(true)
    try {
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
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      setQuickError(error)
      message.error(error)
    } finally {
      setQuickConnecting(false)
    }
  }

  return (
    <div className={styles.welcome}>
      <div className={styles.logo} aria-hidden="true" />
      <h1 className={styles.title}>{t('welcome.title')}</h1>
      <p className={styles.subtitle}>{t('welcome.subtitle')}</p>
      <div className={styles.cards}>
        <button
          type="button"
          className={`${styles.card} ${styles.cardPrimary}`}
          onClick={() => setEditingProfile('new')}
        >
          <div className={styles.cardTitle}>
            <Plug size={16} strokeWidth={1.75} />
            {t('welcome.newConnection')}
          </div>
          <div className={styles.cardDesc}>{t('welcome.newConnectionDesc')}</div>
        </button>

        <section className={styles.card} aria-labelledby="welcome-quick-connect">
          <div className={styles.cardTitle}>
            <Rocket size={16} strokeWidth={1.75} />
            <span id="welcome-quick-connect">{t('welcome.quickConnect')}</span>
          </div>
          <div className={styles.quickForm}>
            <Input
              size="middle"
              aria-label={t('welcome.quickConnectPlaceholder')}
              placeholder={t('welcome.quickConnectPlaceholder')}
              value={quick}
              status={quickError ? 'error' : undefined}
              onChange={(e) => {
                setQuick(e.target.value)
                if (quickError) setQuickError(null)
              }}
              onPressEnter={() => void doQuickConnect()}
              disabled={quickConnecting}
            />
            <Button
              type="primary"
              loading={quickConnecting}
              disabled={!quick.trim()}
              onClick={() => void doQuickConnect()}
            >
              {t('welcome.quickConnect')}
            </Button>
          </div>
          {quickError && (
            <div className={styles.cardError} role="alert">
              {quickError}
            </div>
          )}
        </section>

        <section className={styles.card} aria-labelledby="welcome-recent">
          <div className={styles.cardTitle}>
            <History size={16} strokeWidth={1.75} />
            <span id="welcome-recent">{t('welcome.recent')}</span>
          </div>
          <div className={styles.cardDesc}>
            {recent.length === 0 ? (
              t('welcome.noRecent')
            ) : (
              <div className={styles.recentList}>
                {recent.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className={styles.recentItem}
                    aria-label={`${p.name} (${p.username}@${p.host})`}
                    onClick={() =>
                      void launchProfile(p)
                        .then((kind) => {
                          if (kind === 'rdp') message.success(t('conn.rdpLaunched'))
                        })
                        .catch((err) =>
                          message.error(err instanceof Error ? err.message : String(err))
                        )
                    }
                  >
                    <Server size={12} strokeWidth={1.75} />
                    <span className={styles.recentText}>
                      <span className={styles.recentName}>{p.name}</span>
                      <span className={styles.recentHost}>
                        {p.username}@{p.host}:{p.port}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
