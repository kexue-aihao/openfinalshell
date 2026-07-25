import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Empty, Switch, Tooltip } from 'antd'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ForwardRule } from '@shared/types'
import { describeRule, useForwardStore, type ForwardRuleWithRuntime } from '@/stores/useForwardStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { formatBytes } from '@/utils/format'
import { ForwardRuleModal } from './ForwardRuleModal'
import styles from './ForwardPanel.module.css'

const BADGE: Record<ForwardRule['type'], { text: string; cls: string }> = {
  local: { text: 'L', cls: styles.badgeL },
  remote: { text: 'R', cls: styles.badgeR },
  dynamic: { text: 'D', cls: styles.badgeD }
}

export function ForwardPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { message, modal } = AntdApp.useApp()
  const { rules, loaded, load, save, remove, start, stop } = useForwardStore()
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const profiles = useConnectionStore((s) => s.profiles)
  const [editing, setEditing] = useState<{ open: boolean; rule: ForwardRule | null }>({
    open: false,
    rule: null
  })

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const activeTab = tabs.find((tb) => tb.id === activeTabId)

  /** 规则要用哪个会话来启动：优先当前活动 tab（同 profile），否则任一已连接的同 profile 会话 */
  const sessionForRule = (rule: ForwardRule): string | null => {
    if (activeTab?.profileId === rule.profileId && activeTab.sessionId && activeTab.state === 'ready') {
      return activeTab.sessionId
    }
    const other = tabs.find(
      (tb) => tb.profileId === rule.profileId && tb.sessionId && tb.state === 'ready'
    )
    return other?.sessionId ?? null
  }

  const toggle = async (rule: ForwardRuleWithRuntime, on: boolean): Promise<void> => {
    const sessionId = sessionForRule(rule)
    if (!sessionId) {
      message.warning(t('forward.needSession'))
      return
    }
    try {
      if (on) await start(rule.id, sessionId)
      else await stop(rule.id, sessionId)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
      await load()
    }
  }

  const grouped = profiles
    .map((profile) => ({
      profile,
      items: rules.filter((r) => r.profileId === profile.id)
    }))
    .filter((g) => g.items.length > 0)

  const newRuleProfileId = activeTab?.profileId ?? profiles[0]?.id

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <Button
          size="small"
          block
          icon={<Plus size={14} strokeWidth={1.75} />}
          disabled={!newRuleProfileId}
          onClick={() => setEditing({ open: true, rule: null })}
        >
          {t('forward.new')}
        </Button>
      </div>

      <div className={styles.list}>
        {rules.length === 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              newRuleProfileId ? t('sidebar.emptyForwards') : t('forward.needConnectionFirst')
            }
            style={{ marginTop: 40 }}
          />
        )}
        {grouped.map(({ profile, items }) => (
          <div key={profile.id}>
            <div className={styles.groupName}>{profile.name}</div>
            {items.map((rule) => {
              const badge = BADGE[rule.type]
              const runtime = rule.runtime
              const active = runtime?.state === 'active'
              return (
                <div key={rule.id} className={styles.item}>
                  <div className={styles.itemTop}>
                    <span className={`${styles.badge} ${badge.cls}`}>{badge.text}</span>
                    <span className={styles.itemLabel}>{rule.label}</span>
                    <Switch
                      size="small"
                      checked={active}
                      onChange={(on) => void toggle(rule, on)}
                    />
                  </div>
                  <div className={styles.itemDesc}>{describeRule(rule)}</div>
                  <div className={styles.itemBottom}>
                    {active && (
                      <span className="tabular-nums">
                        {t('forward.conns', { count: runtime?.activeConns ?? 0 })} ·{' '}
                        {formatBytes(runtime?.totalBytes ?? 0)}
                      </span>
                    )}
                    {runtime?.state === 'error' && runtime.error && (
                      <span className={styles.itemError} title={runtime.error}>
                        {runtime.error}
                      </span>
                    )}
                    {rule.autoStart && <span>{t('forward.autoStartTag')}</span>}
                    <span className={styles.spacer} />
                    <Tooltip title={t('common.edit')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<Pencil size={13} strokeWidth={1.75} />}
                        onClick={() => setEditing({ open: true, rule })}
                      />
                    </Tooltip>
                    <Tooltip title={t('common.delete')}>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<Trash2 size={13} strokeWidth={1.75} />}
                        onClick={() =>
                          modal.confirm({
                            title: t('forward.deleteConfirm', { name: rule.label }),
                            okText: t('common.delete'),
                            okButtonProps: { danger: true },
                            cancelText: t('common.cancel'),
                            onOk: () => remove(rule.id)
                          })
                        }
                      />
                    </Tooltip>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {newRuleProfileId && (
        <ForwardRuleModal
          open={editing.open}
          profileId={editing.rule?.profileId ?? newRuleProfileId}
          rule={editing.rule}
          onCancel={() => setEditing({ open: false, rule: null })}
          onOk={async (rule) => {
            setEditing({ open: false, rule: null })
            await save(rule)
          }}
        />
      )}
    </div>
  )
}
