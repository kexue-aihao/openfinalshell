import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, List, Modal, Select, Space, Typography } from 'antd'
import { useUiStore } from '@/stores/useUiStore'
import { ofs } from '@/ipc/api'
import { writeToRegisteredTerm } from '@/features/terminal/termRegistry'
import { useTranslation } from 'react-i18next'
import type { AiMessageContentPart, AiProviderProfile } from '@shared/types'

/** Chat-only window. Provider credentials are managed from Settings → AI assistant. */
export function AiAssistantModal(): React.JSX.Element {
  const { t } = useTranslation()
  const open = useUiStore((s) => s.aiOpen)
  const setOpen = useUiStore((s) => s.setAiOpen)
  const openSettingsSection = useUiStore((s) => s.openSettingsSection)
  const aiPrefill = useUiStore((s) => s.aiPrefill)
  const aiTargetTermId = useUiStore((s) => s.aiTargetTermId)
  const [profiles, setProfiles] = useState<AiProviderProfile[]>([])
  const [selected, setSelected] = useState<string>()
  const [input, setInput] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [requestId, setRequestId] = useState<string>()
  const [image, setImage] = useState<{ name: string; dataUrl: string }>()
  const [insertedCommands, setInsertedCommands] = useState<Set<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (open && aiPrefill) setInput(aiPrefill) }, [open, aiPrefill])
  useEffect(() => { if (open) setInsertedCommands(new Set()) }, [open, aiPrefill])
  useEffect(() => {
    if (!open) return
    void ofs.invoke('ai:profiles:list').then((items) => { setProfiles(items); if (!selected && items[0]) setSelected(items[0].id) }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [open, selected])
  useEffect(() => {
    const offDelta = ofs.on('ai:delta', (e) => { if (e.requestId === requestId) setAnswer((v) => v + e.text) })
    const offDone = ofs.on('ai:completed', (e) => { if (e.requestId === requestId) setBusy(false) })
    const offCancel = ofs.on('ai:cancelled', (e) => { if (e.requestId === requestId) setBusy(false) })
    const offError = ofs.on('ai:error', (e) => { if (e.requestId === requestId) { setBusy(false); setError(e.message) } })
    return () => { offDelta(); offDone(); offCancel(); offError() }
  }, [requestId])

  const chooseImage = (file: File | undefined): void => {
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('只能添加图片文件'); return }
    if (file.size > 8 * 1024 * 1024) { setError('图片不能超过 8 MB'); return }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) { setError('图片格式不受支持'); return }
      setImage({ name: file.name, dataUrl }); setError('')
    }
    reader.onerror = () => setError('读取图片失败')
    reader.readAsDataURL(file)
  }
  const send = async (): Promise<void> => {
    if (!selected || (!input.trim() && !image)) return
    const id = crypto.randomUUID(); setRequestId(id); setAnswer(''); setError(''); setBusy(true)
    const parts: AiMessageContentPart[] = []
    if (input.trim()) parts.push({ type: 'text', text: input.trim() })
    if (image) parts.push({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } })
    const content = parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts
    await ofs.invoke('ai:chat', { requestId: id, profileId: selected, messages: [{ role: 'user', content }] }).catch((e) => { setBusy(false); setError(e instanceof Error ? e.message : String(e)) })
  }
  const commands = answer.match(/```(?:bash|sh|shell|zsh|fish|powershell|pwsh|cmd|bat)?\s*\r?\n([\s\S]*?)```/gi)?.map((block) => {
    const body = block.replace(/^```[^\n]*\r?\n/i, '').replace(/```\s*$/i, '').trim()
    return body
  }).filter(Boolean) ?? []
  const insertCommand = (command: string): void => {
    if (!aiTargetTermId) return
    if (writeToRegisteredTerm(aiTargetTermId, command)) {
      setInsertedCommands((previous) => new Set(previous).add(command))
    } else {
      setError(t('aiCommands.terminalUnavailable'))
    }
  }
  return <Modal open={open} onCancel={() => setOpen(false)} footer={null} width={780} title="AI 助手">
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Typography.Text>服务配置</Typography.Text>
        <Select style={{ width: 260 }} value={selected} placeholder="请先在设置中添加服务" onChange={setSelected} options={profiles.map((p) => ({ value: p.id, label: `${p.name} · ${p.model}` }))} />
        <Button onClick={() => { setOpen(false); openSettingsSection('ai') }}>前往 AI 设置</Button>
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      <List bordered dataSource={answer ? [answer] : []} renderItem={(item) => <List.Item style={{ whiteSpace: 'pre-wrap', minHeight: 160 }}><div style={{ width: '100%' }}>{item}{commands.length > 0 && <Space direction="vertical" style={{ marginTop: 12, width: '100%' }} size={6}>{commands.map((command, index) => <Space key={`${index}-${command.slice(0, 20)}`}><Typography.Text code>{command}</Typography.Text><Button size="small" disabled={!aiTargetTermId || insertedCommands.has(command)} onClick={() => insertCommand(command)}>{insertedCommands.has(command) ? t('aiCommands.inserted') : t('aiCommands.insertToSsh')}</Button></Space>)}</Space>}</div></List.Item>} />
      <Input.TextArea value={input} onChange={(e) => setInput(e.target.value)} placeholder="输入问题；终端文本只有在你主动发送时才会提交" autoSize={{ minRows: 4, maxRows: 10 }} maxLength={32768} />
      {image && <Space size={8}><img src={image.dataUrl} alt={image.name} style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 4 }} /><Typography.Text type="secondary">{image.name}</Typography.Text><Button type="link" onClick={() => setImage(undefined)}>移除图片</Button></Space>}
      <Space>
        <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { chooseImage(e.target.files?.[0]); e.currentTarget.value = '' }} />
        <Button onClick={() => fileInputRef.current?.click()} disabled={busy}>添加图片</Button>
        <Button type="primary" loading={busy} disabled={!selected || (!input.trim() && !image)} onClick={() => void send()}>发送</Button>
        {busy && <Button onClick={() => requestId && void ofs.invoke('ai:cancel', requestId)}>停止生成</Button>}
        <Button onClick={() => setAnswer('')}>清空回答</Button>
      </Space>
    </Space>
  </Modal>
}
