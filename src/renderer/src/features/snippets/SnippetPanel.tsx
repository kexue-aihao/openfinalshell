import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Empty, Form, Input, Modal, Switch, Tooltip } from 'antd'
import { Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Snippet } from '@shared/types'
import { ofs } from '@/ipc/api'
import { expandSnippet, useSnippetStore } from '@/stores/useSnippetStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import styles from './SnippetPanel.module.css'

interface EditState {
  open: boolean
  snippet: Snippet | null
}

export function SnippetPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { message, modal } = AntdApp.useApp()
  const { groups, snippets, loaded, history, load, save, remove, pushHistory } = useSnippetStore()
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const profiles = useConnectionStore((s) => s.profiles)
  const [edit, setEdit] = useState<EditState>({ open: false, snippet: null })
  const [form] = Form.useForm<{ name: string; command: string; autoEnter: boolean }>()

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const activeTab = tabs.find((tb) => tb.id === activeTabId)
  const activeProfile = profiles.find((p) => p.id === activeTab?.profileId)

  const send = (command: string, autoEnter: boolean, toAll = false): void => {
    const targets = toAll ? tabs.filter((tb) => tb.termId) : activeTab?.termId ? [activeTab] : []
    if (targets.length === 0) {
      message.warning(t('snippet.noActiveTerminal'))
      return
    }
    for (const tab of targets) {
      const profile = profiles.find((p) => p.id === tab.profileId)
      const text = expandSnippet(command, {
        host: profile?.host,
        user: profile?.username,
        port: profile?.port
      })
      void ofs.invoke('term:exec', {
        termId: tab.termId!,
        command: autoEnter ? `${text}\n` : text
      })
    }
    pushHistory(command)
  }

  const openEdit = (snippet: Snippet | null): void => {
    setEdit({ open: true, snippet })
    form.setFieldsValue({
      name: snippet?.name ?? '',
      command: snippet?.command ?? '',
      autoEnter: snippet?.autoEnter ?? true
    })
  }

  const submitEdit = async (): Promise<void> => {
    const v = await form.validateFields()
    const groupId = edit.snippet?.groupId ?? groups[0]?.id ?? 'default'
    await save({
      id: edit.snippet?.id ?? crypto.randomUUID(),
      groupId,
      name: v.name.trim(),
      command: v.command,
      autoEnter: v.autoEnter,
      order: edit.snippet?.order ?? snippets.length
    })
    setEdit({ open: false, snippet: null })
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <Button
          size="small"
          block
          icon={<Plus size={14} strokeWidth={1.75} />}
          onClick={() => openEdit(null)}
        >
          {t('snippet.new')}
        </Button>
      </div>

      <div className={styles.list}>
        {snippets.length === 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('sidebar.emptySnippets')}
            style={{ marginTop: 40 }}
          />
        )}
        {groups.map((g) => {
          const items = snippets.filter((s) => s.groupId === g.id).sort((a, b) => a.order - b.order)
          if (items.length === 0) return null
          return (
            <div key={g.id}>
              <div className={styles.groupName}>{g.name}</div>
              {items.map((s) => (
                <div key={s.id} className={styles.item} onClick={() => send(s.command, s.autoEnter)}>
                  <div className={styles.itemMain}>
                    <div className={styles.itemName}>{s.name}</div>
                    <div className={styles.itemCmd}>{s.command.split('\n')[0]}</div>
                  </div>
                  <div className={styles.itemActions}>
                    <Tooltip title={t('snippet.sendToAll')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<Send size={13} strokeWidth={1.75} />}
                        onClick={(e) => {
                          e.stopPropagation()
                          send(s.command, s.autoEnter, true)
                        }}
                      />
                    </Tooltip>
                    <Button
                      size="small"
                      type="text"
                      icon={<Pencil size={13} strokeWidth={1.75} />}
                      onClick={(e) => {
                        e.stopPropagation()
                        openEdit(s)
                      }}
                    />
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<Trash2 size={13} strokeWidth={1.75} />}
                      onClick={(e) => {
                        e.stopPropagation()
                        modal.confirm({
                          title: t('snippet.deleteConfirm', { name: s.name }),
                          okText: t('common.delete'),
                          okButtonProps: { danger: true },
                          cancelText: t('common.cancel'),
                          onOk: () => remove(s.id)
                        })
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {history.length > 0 && (
        <div className={styles.history}>
          <div className={styles.groupName}>{t('snippet.history')}</div>
          {history.map((cmd, i) => (
            <div
              key={`${cmd}-${i}`}
              className={styles.historyItem}
              title={cmd}
              onDoubleClick={() => send(cmd, true)}
            >
              {cmd}
            </div>
          ))}
        </div>
      )}

      <Modal
        open={edit.open}
        title={edit.snippet ? t('snippet.editTitle') : t('snippet.new')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        onOk={() => void submitEdit()}
        onCancel={() => setEdit({ open: false, snippet: null })}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label={t('snippet.name')}
            rules={[{ required: true, message: t('snippet.nameRequired') }]}
          >
            <Input autoFocus />
          </Form.Item>
          <Form.Item
            name="command"
            label={t('snippet.command')}
            extra={
              <span>
                {t('snippet.placeholderHint')}
                <code>{'{{host}}'}</code>
                {activeProfile ? ` → ${activeProfile.host} · ` : ' · '}
                <code>{'{{user}}'}</code>
                {activeProfile ? ` → ${activeProfile.username} · ` : ' · '}
                <code>{'{{port}}'}</code>
              </span>
            }
            rules={[{ required: true, message: t('snippet.commandRequired') }]}
          >
            <Input.TextArea rows={4} style={{ fontFamily: 'ui-monospace, Consolas, monospace' }} />
          </Form.Item>
          <Form.Item name="autoEnter" label={t('snippet.autoEnter')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
