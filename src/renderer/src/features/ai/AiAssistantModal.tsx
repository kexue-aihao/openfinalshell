import { useEffect, useRef, useState } from 'react'
import { Alert, App as AntdApp, Button, Input, Modal, Select, Space, Typography } from 'antd'
import { useUiStore } from '@/stores/useUiStore'
import { useSessionStore, type SessionTab } from '@/stores/useSessionStore'
import { ofs } from '@/ipc/api'
import { getTerm, registeredTermPasteIssue, writeToRegisteredTerm } from '@/features/terminal/termRegistry'
import { useTranslation } from 'react-i18next'
import { AiResponse } from './AiResponse'
import type { AiMessageContentPart, AiProviderProfile, TermId } from '@shared/types'

function readySshTabs(): SessionTab[] {
  return useSessionStore.getState().tabs.filter((tab) => (!tab.kind || tab.kind === 'terminal') && tab.state === 'ready' && !!tab.termId)
}

export function AiAssistantModal(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const open = useUiStore((s) => s.aiOpen)
  const setOpen = useUiStore((s) => s.setAiOpen)
  const openSettingsSection = useUiStore((s) => s.openSettingsSection)
  const aiPrefill = useUiStore((s) => s.aiPrefill)
  const aiTargetTermId = useUiStore((s) => s.aiTargetTermId)
  const setAiTargetTermId = useUiStore((s) => s.setAiTargetTermId)
  const [profiles, setProfiles] = useState<AiProviderProfile[]>([])
  const [selected, setSelected] = useState<string>()
  const [input, setInput] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [requestId, setRequestId] = useState<string>()
  const [stream, setStream] = useState(true)
  const [image, setImage] = useState<{ name: string; dataUrl: string }>()
  const sessionTabs = useSessionStore((s) => s.tabs)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef<string>()

  useEffect(() => { if (open && aiPrefill) setInput(aiPrefill) }, [open, aiPrefill])
  useEffect(() => {
    if (!open) return
    void ofs.invoke('ai:profiles:list').then((items) => { setProfiles(items); if (!selected && items[0]) setSelected(items[0].id) }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [open])
  useEffect(() => {
    const offDelta = ofs.on('ai:delta', (e) => { if (e.requestId === requestRef.current) setAnswer((v) => v + e.text) })
    const finish = (id: string): void => { if (id === requestRef.current) { setBusy(false); requestRef.current = undefined } }
    const offDone = ofs.on('ai:completed', (e) => finish(e.requestId))
    const offCancel = ofs.on('ai:cancelled', (e) => finish(e.requestId))
    const offError = ofs.on('ai:error', (e) => { if (e.requestId === requestRef.current) { setBusy(false); requestRef.current = undefined; setError(e.message) } })
    return () => { offDelta(); offDone(); offCancel(); offError() }
  }, [])
  const chooseImage = (file: File | undefined): void => {
    if (!file) return
    if (!file.type.startsWith('image/')) { setError(t('aiCommands.imageOnly')); return }
    if (file.size > 8 * 1024 * 1024) { setError(t('aiCommands.imageTooLarge')); return }
    const reader = new FileReader()
    reader.onload = () => { const dataUrl = typeof reader.result === 'string' ? reader.result : ''; if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) { setError(t('aiCommands.imageUnsupported')); return }; setImage({ name: file.name, dataUrl }); setError('') }
    reader.onerror = () => setError(t('aiCommands.imageReadFailed'))
    reader.readAsDataURL(file)
  }
  const send = async (): Promise<void> => {
    if (!selected || (!input.trim() && !image)) return
    const id = crypto.randomUUID(); requestRef.current = id; setRequestId(id); setAnswer(''); setError(''); setBusy(true)
    const parts: AiMessageContentPart[] = []
    if (input.trim()) parts.push({ type: 'text', text: input.trim() })
    if (image) parts.push({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } })
    const content = parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts
    await ofs.invoke('ai:chat', { requestId: id, profileId: selected, stream, messages: [{ role: 'user', content }] }).catch((e) => { if (requestRef.current === id) { setBusy(false); requestRef.current = undefined; setError(e instanceof Error ? e.message : String(e)) } })
  }
  const targetTab = (): SessionTab | undefined => { const tab = readySshTabs().find((item) => item.termId === aiTargetTermId); return tab && getTerm(aiTargetTermId as TermId) ? tab : undefined }
  const insertIssue = (text: string): string | undefined => {
    if (busy) return t('aiCommands.waitForCompletion')
    if (!aiTargetTermId) return t('aiCommands.selectSsh')
    if (!targetTab()) return t('aiCommands.terminalUnavailable')
    const issue = registeredTermPasteIssue(aiTargetTermId, text)
    if (issue === 'multilineUnsupported') return t('aiCommands.multilineUnsupported')
    if (issue === 'tooLong') return t('aiCommands.commandTooLong')
    if (issue === 'controlCharacters') return t('aiCommands.controlCharacters')
    if (issue === 'empty') return t('aiCommands.emptyCommand')
    if (issue === 'unavailable') return t('aiCommands.terminalUnavailable')
    return undefined
  }
  const insert = (text: string): void => { const tab = targetTab(); const issue = insertIssue(text); if (!tab || !tab.termId || issue) { setError(issue ?? t('aiCommands.terminalUnavailable')); return }; if (writeToRegisteredTerm(tab.termId, text)) { message.success(t('aiCommands.inserted')); useSessionStore.getState().setActiveTab(tab.id); setOpen(false) } else setError(t('aiCommands.terminalUnavailable')) }
  const copy = (text: string): void => { const clipboard = navigator.clipboard; if (!clipboard) { setError(t('aiCommands.copyFailed')); return }; void clipboard.writeText(text).then(() => message.success(t('aiCommands.copied'))).catch(() => setError(t('aiCommands.copyFailed'))) }
  const tabs = sessionTabs.filter((tab) => (!tab.kind || tab.kind === 'terminal') && tab.state === 'ready' && !!tab.termId)
  const targetOptions = tabs.map((tab) => ({ value: tab.termId!, label: tab.title }))
  const currentTargetAvailable = !!targetTab()
  const close = (): void => { if (requestRef.current) void ofs.invoke('ai:cancel', requestRef.current); requestRef.current = undefined; setBusy(false); setOpen(false) }
  return <Modal open={open} onCancel={close} footer={null} width={820} title={t('aiAssistant.title')} focusTriggerAfterClose={false}>
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap><Typography.Text>{t('aiAssistant.profile')}</Typography.Text><Select style={{ width: 260 }} value={selected} placeholder={t('aiAssistant.chooseProfile')} onChange={setSelected} options={profiles.map((p) => ({ value: p.id, label: `${p.name} · ${p.model}` }))} /><Button onClick={() => { setOpen(false); openSettingsSection('ai') }}>{t('aiAssistant.openSettings')}</Button></Space>
      <Space wrap><Typography.Text>{t('aiCommands.targetSsh')}</Typography.Text><Select allowClear style={{ minWidth: 280 }} value={currentTargetAvailable ? aiTargetTermId : undefined} placeholder={t('aiCommands.selectSsh')} onChange={setAiTargetTermId} options={targetOptions} />{!currentTargetAvailable && aiTargetTermId && <Typography.Text type="warning">{t('aiCommands.terminalUnavailable')}</Typography.Text>}</Space>
      <Space wrap><Typography.Text>{t('aiAssistant.responseMode')}</Typography.Text><Select value={stream ? 'stream' : 'nonstream'} style={{ width: 180 }} onChange={(value: 'stream' | 'nonstream') => setStream(value === 'stream')} options={[{ value: 'stream', label: t('aiAssistant.stream') }, { value: 'nonstream', label: t('aiAssistant.nonstream') }]} /></Space>
      {error && <Alert type="error" showIcon message={error} />}
      {answer && <AiResponse answer={answer} busy={busy} onCopy={copy} onInsert={insert} insertIssue={insertIssue} />}
      <Input.TextArea value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('aiAssistant.inputPlaceholder')} autoSize={{ minRows: 4, maxRows: 10 }} maxLength={32768} />
      {image && <Space size={8}><img src={image.dataUrl} alt={image.name} style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 4 }} /><Typography.Text type="secondary">{image.name}</Typography.Text><Button type="link" onClick={() => setImage(undefined)}>{t('aiCommands.removeImage')}</Button></Space>}
      <Space><input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { chooseImage(e.target.files?.[0]); e.currentTarget.value = '' }} /><Button onClick={() => fileInputRef.current?.click()} disabled={busy}>{t('aiCommands.addImage')}</Button><Button type="primary" loading={busy} disabled={!selected || (!input.trim() && !image)} onClick={() => void send()}>{t('aiAssistant.send')}</Button>{busy && <Button onClick={() => { if (requestId) void ofs.invoke('ai:cancel', requestId); requestRef.current = undefined; setBusy(false) }}>{t('aiAssistant.stop')}</Button>}<Button onClick={() => { requestRef.current = undefined; setBusy(false); setAnswer('') }}>{t('aiAssistant.clear')}</Button></Space>
    </Space>
  </Modal>
}
