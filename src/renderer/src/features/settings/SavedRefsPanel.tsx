import { useEffect, useMemo, useState } from 'react'
import { App as AntdApp, Button, Empty, Modal, Select, Typography } from 'antd'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SavedPrivateKey, SavedProxy } from '@shared/types'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSavedRefStore } from '@/stores/useSavedRefStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { PrivateKeyEditModal, ProxyEditModal } from './SavedRefModals'
import styles from './SettingsModal.module.css'

/**
 * 设置 →「代理与私钥」：这两类可复用实体的管理界面。
 *
 * 放设置页而不是侧栏：它们是"配一次、到处引用"的东西，与连接树的日常操作不同频。
 *
 * 每一条都显示**有几台机器在用它** —— 这既是有用的信息，也是删除被拦下时那句话的依据。
 * 引用数在渲染进程这边算（`useConnectionStore` 里已经有全部 profile），
 * 与 main 侧删除时重新算一遍并不冲突：**判据在 main**，这里只是提前告诉用户。
 */
export function SavedRefsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { message, modal } = AntdApp.useApp()
  const proxies = useSavedRefStore((s) => s.proxies)
  const keys = useSavedRefStore((s) => s.keys)
  const loaded = useSavedRefStore((s) => s.loaded)
  const load = useSavedRefStore((s) => s.load)
  const removeProxy = useSavedRefStore((s) => s.removeProxy)
  const removeKey = useSavedRefStore((s) => s.removeKey)
  const profiles = useConnectionStore((s) => s.profiles)
  const loadProfiles = useConnectionStore((s) => s.load)
  const profilesLoaded = useConnectionStore((s) => s.loaded)
  const settings = useSettingsStore((s) => s.settings)!
  const patchSettings = useSettingsStore((s) => s.patch)

  const [editingProxy, setEditingProxy] = useState<'new' | SavedProxy | null>(null)
  const [editingKey, setEditingKey] = useState<'new' | SavedPrivateKey | null>(null)

  useEffect(() => {
    if (!loaded) void load()
    // 引用计数要靠连接列表；设置页可能在连接树还没加载过的时候就被打开
    if (!profilesLoaded) void loadProfiles()
  }, [loaded, load, profilesLoaded, loadProfiles])

  const proxyUsers = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of profiles) {
      if (!p.proxyId) continue
      m.set(p.proxyId, [...(m.get(p.proxyId) ?? []), p.name])
    }
    return m
  }, [profiles])

  const keyUsers = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of profiles) {
      const id = p.auth.privateKeyId
      if (!id) continue
      m.set(id, [...(m.get(id) ?? []), p.name])
    }
    return m
  }, [profiles])

  /**
   * 删除。**被引用时 main 侧不删**，回来一份连接名清单 —— 这里原样列给用户，
   * 让他知道该去改哪几条连接。不抛异常也不静默失败。
   */
  const doDelete = (
    kind: 'proxy' | 'key',
    item: { id: string; name: string }
  ): void => {
    modal.confirm({
      title: t('savedRef.deleteConfirm', { name: item.name }),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        const r = kind === 'proxy' ? await removeProxy(item.id) : await removeKey(item.id)
        if (r.deleted) {
          message.success(t('conn.deleted'))
          return
        }
        Modal.error({
          title: t('savedRef.blockedTitle', { name: item.name }),
          content: (
            <div>
              <div style={{ marginBottom: 6 }}>{t('savedRef.blockedDesc')}</div>
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {r.usedBy.slice(0, 10).map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              {r.usedBy.length > 10 && (
                <div>{t('savedRef.blockedMore', { count: r.usedBy.length - 10 })}</div>
              )}
            </div>
          )
        })
      }
    })
  }

  const row = (
    key: string,
    title: string,
    subtitle: string,
    users: string[],
    onEdit: () => void,
    onDelete: () => void
  ): React.JSX.Element => (
    <div key={key} className={styles.refRow}>
      <div className={styles.refMain}>
        <div className={styles.refName}>{title}</div>
        <div className={styles.refSub}>{subtitle}</div>
      </div>
      <span className={styles.refUsers}>
        {users.length > 0 ? t('savedRef.usedBy', { count: users.length }) : t('savedRef.unused')}
      </span>
      <Button size="small" type="text" icon={<Pencil size={13} strokeWidth={1.75} />} onClick={onEdit} />
      <Button
        size="small"
        type="text"
        danger
        icon={<Trash2 size={13} strokeWidth={1.75} />}
        onClick={onDelete}
      />
    </div>
  )

  return (
    <>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t('savedRef.desc')}
      </Typography.Paragraph>

      {/* 全局默认代理：新建连接（跟随全局）走它，改这里实时影响所有"跟随全局"的连接 */}
      <div className={styles.refHead}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('savedRef.defaultProxy')}
        </Typography.Title>
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        {t('savedRef.defaultProxyHint')}
      </Typography.Paragraph>
      <Select
        style={{ width: 360, marginBottom: 20 }}
        value={settings.connection.defaultProxyId ?? ''}
        onChange={(v) =>
          patchSettings({ connection: { ...settings.connection, defaultProxyId: v || null } })
        }
        options={[
          { label: t('conn.proxyNone'), value: '' },
          ...proxies.map((x) => ({
            label: `${x.name}（${x.type.toUpperCase()} ${x.host}:${x.port}）`,
            value: x.id
          }))
        ]}
      />

      <div className={styles.refHead}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('savedRef.proxies')}
        </Typography.Title>
        <Button
          size="small"
          icon={<Plus size={13} strokeWidth={1.75} />}
          onClick={() => setEditingProxy('new')}
        >
          {t('savedRef.proxyNew')}
        </Button>
      </div>
      {proxies.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('savedRef.emptyProxies')} />
      ) : (
        proxies.map((p) =>
          row(
            p.id,
            p.name,
            `${p.type.toUpperCase()} ${p.host}:${p.port}${p.username ? ` · ${p.username}` : ''}`,
            proxyUsers.get(p.id) ?? [],
            () => setEditingProxy(p),
            () => doDelete('proxy', p)
          )
        )
      )}

      <div className={styles.refHead} style={{ marginTop: 20 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('savedRef.keys')}
        </Typography.Title>
        <Button
          size="small"
          icon={<Plus size={13} strokeWidth={1.75} />}
          onClick={() => setEditingKey('new')}
        >
          {t('savedRef.keyNew')}
        </Button>
      </div>
      {keys.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('savedRef.emptyKeys')} />
      ) : (
        keys.map((k) =>
          row(
            k.id,
            k.name,
            `${k.path}${k.passphraseRef ? ` · ${t('conn.passphraseSaved')}` : ''}${k.materialRef ? ` · ${t('savedRef.keyStoreCopy')}` : ''}`,
            keyUsers.get(k.id) ?? [],
            () => setEditingKey(k),
            () => doDelete('key', k)
          )
        )
      )}

      {editingProxy && (
        <ProxyEditModal target={editingProxy} onClose={() => setEditingProxy(null)} />
      )}
      {editingKey && (
        <PrivateKeyEditModal target={editingKey} onClose={() => setEditingKey(null)} />
      )}
    </>
  )
}
