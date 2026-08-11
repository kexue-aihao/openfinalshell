import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Empty, Form, Input, Modal, Switch, Tooltip } from 'antd'
import { Pencil, Plus, Send, SquarePen, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Snippet } from '@shared/types'
import { ofs } from '@/ipc/api'
import { emitExecutedCommands } from '@/features/terminal/commandEvents'
import { noteProgrammaticWrite } from '@/features/terminal/termRegistry'
import { useCommandEditorStore } from '@/stores/useCommandEditorStore'
import { useHistoryStore } from '@/stores/useHistoryStore'
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
  const { groups, snippets, loaded, load, save, remove } = useSnippetStore()
  /**
   * 历史来自 useHistoryStore —— 与终端里敲的命令是**同一份**、落库、跨重启还在。
   * 上一版这里读的是 useSnippetStore 里一个纯内存数组，只装"从这个面板点出去的命令"，
   * 于是每次启动它都是空的，而空的时候整块不渲染 → 这个功能等于不存在。
   */
  const history = useHistoryStore((s) => s.entries)
  const historyLoaded = useHistoryStore((s) => s.loaded)
  const loadHistory = useHistoryStore((s) => s.load)
  const pushHistory = useHistoryStore((s) => s.push)
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const profiles = useConnectionStore((s) => s.profiles)
  const [edit, setEdit] = useState<EditState>({ open: false, snippet: null })
  const [form] = Form.useForm<{ name: string; command: string; autoEnter: boolean }>()

  useEffect(() => {
    if (!loaded) void load()
    if (!historyLoaded) void loadHistory()
  }, [loaded, load, historyLoaded, loadHistory])

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
      // 这一行是程序写进去的，提示符列不再可信（语义见 features/terminal/commandCapture.ts）
      noteProgrammaticWrite(tab.termId!)
      void ofs.invoke('term:exec', {
        termId: tab.termId!,
        command: autoEnter ? `${text}\n` : text
      })
      /*
       * 只在**真的执行了**（autoEnter）时记历史，而且记展开后的原话 ——
       * 历史是"执行过什么"，不是"点过什么"，所以 {{host}} 那类占位符要按当时那台机器展开。
       * autoEnter=false 时命令只是躺在命令行上等用户按回车，那一下由终端那侧的采集记，
       * 在这里再记一遍就成了"没执行也进历史"。
       *
       * 宣告同理：程序化执行没有 Enter keydown，读屏采集整条不启动，
       * SFTP 的 cd 跟随全靠这一句（语义与守卫见 emitExecutedCommands）。
       */
      if (autoEnter) {
        pushHistory(text)
        emitExecutedCommands(tab.id, tab.termId!, text)
      }
    }
  }

  /**
   * 把一条历史回填到当前终端的命令行。**不带回车** —— 与命令历史浮层同一条规矩：
   * 列表里躺着的是在生产服务器上敲过的原话，单击就执行会把误点的代价定在事故那一档。
   */
  const refill = (command: string): void => {
    const termId = activeTab?.termId
    if (!termId) {
      message.warning(t('snippet.noActiveTerminal'))
      return
    }
    noteProgrammaticWrite(termId)
    ofs.send('term:input', { termId, data: command })
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
        {/* 命令编辑器：临时拼一段多行命令发出去（与"存起来反复用"的快捷命令分工不同） */}
        <Tooltip title={t('commandEditor.openHint')}>
          <Button
            size="small"
            icon={<SquarePen size={14} strokeWidth={1.75} />}
            onClick={() => useCommandEditorStore.getState().openBlank()}
          />
        </Tooltip>
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

      {/*
        * 历史那一块**恒常显示**（空的时候给一行说明）。上一版是 history.length > 0 才渲染，
        * 而那份历史又不持久化 —— 于是每次启动这一块在 DOM 里根本不存在，
        * 没人能发现这个功能。空态是这里唯一的入口说明。
        *
        * 单击=回填到命令行，与命令历史浮层完全一致（上一版是双击直接执行，
        * 既与上面的快捷命令项不一致，又让误点的代价变成"在生产上执行一条旧命令"）。
        */}
      <div className={styles.history}>
        <div className={styles.groupName}>{t('snippet.history')}</div>
        {history.length === 0 ? (
          <div className={styles.historyEmpty}>{t('snippet.historyEmpty')}</div>
        ) : (
          history.slice(0, 20).map((entry) => (
            <div
              key={entry.command}
              className={styles.historyItem}
              title={t('snippet.historyItemTip', { command: entry.command })}
              onClick={() => refill(entry.command)}
            >
              {entry.command}
            </div>
          ))
        )}
      </div>

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
