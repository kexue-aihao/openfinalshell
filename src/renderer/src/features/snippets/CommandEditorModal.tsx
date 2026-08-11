import { useState } from 'react'
import { App as AntdApp, Button, Input, Modal, Segmented, Switch, Tooltip, Typography } from 'antd'
import { Send, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ofs } from '@/ipc/api'
import { emitExecutedCommands } from '@/features/terminal/commandEvents'
import { noteProgrammaticWrite } from '@/features/terminal/termRegistry'
import { useCommandEditorStore } from '@/stores/useCommandEditorStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useHistoryStore } from '@/stores/useHistoryStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { expandSnippet, useSnippetStore } from '@/stores/useSnippetStore'
import {
  buildSendText,
  historyEntryFor,
  normalizeBody,
  resolveTargets,
  type SendTarget
} from './commandEditorSend'
import styles from './CommandEditorModal.module.css'

/**
 * 命令编辑器：一块多行文本 + 「发送到 当前会话 / 所有会话」+ 「发送」。
 *
 * 与「快捷命令」的分工是清楚的：快捷命令是**存起来反复用**的那些（有名字、有分组），
 * 这一格是**临时拼一段**（多行脚本、一次性的 for 循环、从别处贴进来改两个字段）。
 * 写完觉得值得留就点「保存为快捷命令」。
 *
 * 用 antd 的 TextArea 而**不是** CodeMirror：这一格是命令输入框，不是代码编辑器。
 * CodeEditor.tsx 那份注释里写着"整个渲染进程里唯一 new EditorView 的地方"，
 * 而它整套设计（每文件暂存 state、脏标记走 rope 比较、按 fileKey 清理草稿）
 * 是为"编辑远端文件"那件事长出来的 —— 为了一个命令输入框把第二个 EditorView 引进来，
 * 要么得拆那份设计，要么得复制一遍它的生命周期管理，两样都不值得。
 */
export function CommandEditorModal(): React.JSX.Element {
  const { t } = useTranslation()
  const { message, modal } = AntdApp.useApp()
  const open = useCommandEditorStore((s) => s.open)
  const setOpen = useCommandEditorStore((s) => s.setOpen)
  const text = useCommandEditorStore((s) => s.text)
  const setText = useCommandEditorStore((s) => s.setText)
  const target = useCommandEditorStore((s) => s.target)
  const setTarget = useCommandEditorStore((s) => s.setTarget)
  const autoEnter = useCommandEditorStore((s) => s.autoEnter)
  const setAutoEnter = useCommandEditorStore((s) => s.setAutoEnter)
  const expandVars = useCommandEditorStore((s) => s.expandVars)
  const setExpandVars = useCommandEditorStore((s) => s.setExpandVars)

  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const profiles = useConnectionStore((s) => s.profiles)
  const saveSnippet = useSnippetStore((s) => s.save)
  const snippetGroups = useSnippetStore((s) => s.groups)
  const pushHistory = useHistoryStore((s) => s.push)
  const [saving, setSaving] = useState(false)

  /** 真正的发送。多行时按设置弹一次确认（与终端粘贴同一条规矩、同一份文案） */
  const doSend = (): void => {
    const payload = buildSendText(text, autoEnter)
    if (payload === '') {
      message.warning(t('commandEditor.empty'))
      return
    }
    const targets = resolveTargets(tabs, activeTabId, target)
    if (targets.length === 0) {
      message.warning(t('snippet.noActiveTerminal'))
      return
    }

    const send = (): void => {
      for (const tab of targets) {
        const profile = profiles.find((p) => p.id === tab.profileId)
        const body = expandVars
          ? expandSnippet(payload, {
              host: profile?.host,
              user: profile?.username,
              port: profile?.port
            })
          : payload
        // 这一行是程序写进去的，提示符列不再可信（见 features/terminal/commandCapture.ts）
        noteProgrammaticWrite(tab.termId!)
        void ofs.invoke('term:exec', { termId: tab.termId!, command: body })
        // 程序化执行没有 Enter 采集，SFTP 的 cd 跟随全靠这一句宣告（见 emitExecutedCommands）
        if (autoEnter) emitExecutedCommands(tab.id, tab.termId!, body)
        /*
         * 只有真的执行了（autoEnter）才记历史，记的是**展开后**发出去的那一段 ——
         * 判据与理由都在 historyEntryFor 里，这里不重复判。
         */
        const entry = historyEntryFor(expandVars ? body : payload, autoEnter)
        if (entry) pushHistory(entry)
      }
      message.success(t('commandEditor.sent', { count: targets.length }))
      // 发完自动关窗，让用户回到终端看执行效果；顺手清空正文，下次打开是空白的
      setText('')
      setOpen(false)
    }

    const lines = payload.replace(/\n$/, '').split('\n').length
    const settings = useSettingsStore.getState().settings
    if (autoEnter && lines > 1 && settings?.terminal.confirmMultilinePaste) {
      modal.confirm({
        title: t('terminal.multilinePasteTitle'),
        content: t('terminal.multilinePasteContent', { lines }),
        okText: t('common.ok'),
        cancelText: t('common.cancel'),
        onOk: send
      })
      return
    }
    send()
  }

  /** 存成快捷命令：名字问一次，分组落在第一个分组里（与快捷命令面板新建时同一条规矩） */
  const saveAsSnippet = (): void => {
    const body = normalizeBody(text)
    if (body.trim() === '') {
      message.warning(t('commandEditor.empty'))
      return
    }
    let name = ''
    modal.confirm({
      title: t('commandEditor.saveAsSnippetName'),
      content: <Input autoFocus onChange={(e) => (name = e.target.value)} />,
      okText: t('common.save'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        const trimmed = name.trim()
        if (!trimmed) {
          message.warning(t('snippet.nameRequired'))
          throw new Error('empty name')
        }
        setSaving(true)
        try {
          await saveSnippet({
            id: crypto.randomUUID(),
            groupId: snippetGroups[0]?.id ?? 'default',
            name: trimmed,
            command: body,
            autoEnter,
            order: Date.now()
          })
          message.success(t('conn.saved'))
        } finally {
          setSaving(false)
        }
      }
    })
  }

  return (
    <Modal
      open={open}
      title={t('commandEditor.title')}
      width={760}
      onCancel={() => setOpen(false)}
      footer={null}
      // 正文不跨"打开"保留：openBlank 每次清空、发送后也清空（见 useCommandEditorStore）。
      // destroyOnHidden 保持 false 即可 —— 正文由 store 受控，清空它就等于清空这一格
      destroyOnHidden={false}
    >
      <Input.TextArea
        className={styles.editor}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('commandEditor.placeholder')}
        rows={14}
        spellCheck={false}
        /*
         * Ctrl+Enter 发送。刻意**不用**单独的 Enter —— 这一格的用途就是写多行，
         * Enter 必须是换行。
         */
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            doSend()
          }
        }}
      />

      <Typography.Paragraph type="secondary" className={styles.hint}>
        {t('snippet.placeholderHint')}
        <code>{'{{host}}'}</code> · <code>{'{{user}}'}</code> · <code>{'{{port}}'}</code>
      </Typography.Paragraph>

      <div className={styles.bar}>
        <span className={styles.options}>
          <Tooltip title={t('commandEditor.autoEnterHint')}>
            <span className={styles.option}>
              <Switch size="small" checked={autoEnter} onChange={setAutoEnter} />
              {t('commandEditor.autoEnter')}
            </span>
          </Tooltip>
          <Tooltip
            title={
              <>
                {t('commandEditor.expandVarsHint')} <code>{'{{host}}'}</code>{' '}
                <code>{'{{user}}'}</code> <code>{'{{port}}'}</code>
              </>
            }
          >
            <span className={styles.option}>
              <Switch size="small" checked={expandVars} onChange={setExpandVars} />
              {t('commandEditor.expandVars')}
            </span>
          </Tooltip>
        </span>

        <Button
          size="small"
          loading={saving}
          icon={<Star size={13} strokeWidth={1.75} />}
          onClick={saveAsSnippet}
        >
          {t('commandEditor.saveAsSnippet')}
        </Button>
        <span className={styles.sendTo}>{t('commandEditor.sendTo')}</span>
        <Segmented
          size="small"
          value={target}
          onChange={(v) => setTarget(v as SendTarget)}
          options={[
            { label: t('commandEditor.targetCurrent'), value: 'current' },
            { label: t('commandEditor.targetAll'), value: 'all' }
          ]}
        />
        <Tooltip title={t('commandEditor.sendHint')}>
          <Button type="primary" size="small" icon={<Send size={13} strokeWidth={1.75} />} onClick={doSend}>
            {t('commandEditor.send')}
          </Button>
        </Tooltip>
      </div>
    </Modal>
  )
}
