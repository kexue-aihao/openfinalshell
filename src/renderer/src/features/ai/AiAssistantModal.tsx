import { useEffect, useState } from 'react'
import { Alert, Button, Input, List, Modal, Select, Space, Typography } from 'antd'
import { useUiStore } from '@/stores/useUiStore'
import { ofs } from '@/ipc/api'
import type { AiProviderProfile } from '@shared/types'

/** Chat-only window. Provider credentials are managed from Settings → AI assistant. */
export function AiAssistantModal(): React.JSX.Element {
  const open = useUiStore((s) => s.aiOpen)
  const setOpen = useUiStore((s) => s.setAiOpen)
  const openSettingsSection = useUiStore((s) => s.openSettingsSection)
  const aiPrefill = useUiStore((s) => s.aiPrefill)
  const [profiles, setProfiles] = useState<AiProviderProfile[]>([])
  const [selected, setSelected] = useState<string>()
  const [input, setInput] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [requestId, setRequestId] = useState<string>()

  useEffect(() => { if (open && aiPrefill) setInput(aiPrefill) }, [open, aiPrefill])
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

  const send = async (): Promise<void> => {
    if (!selected || !input.trim()) return
    const id = crypto.randomUUID(); setRequestId(id); setAnswer(''); setError(''); setBusy(true)
    await ofs.invoke('ai:chat', { requestId: id, profileId: selected, messages: [{ role: 'user', content: input.trim() }] }).catch((e) => { setBusy(false); setError(e instanceof Error ? e.message : String(e)) })
  }
  return <Modal open={open} onCancel={() => setOpen(false)} footer={null} width={780} title="AI 助手">
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Typography.Text>服务配置</Typography.Text>
        <Select style={{ width: 260 }} value={selected} placeholder="请先在设置中添加服务" onChange={setSelected} options={profiles.map((p) => ({ value: p.id, label: `${p.name} · ${p.model}` }))} />
        <Button onClick={() => { setOpen(false); openSettingsSection('ai') }}>前往 AI 设置</Button>
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      <List bordered dataSource={answer ? [answer] : []} renderItem={(item) => <List.Item style={{ whiteSpace: 'pre-wrap', minHeight: 160 }}>{item}</List.Item>} />
      <Input.TextArea value={input} onChange={(e) => setInput(e.target.value)} placeholder="输入问题；终端文本只有在你主动发送时才会提交" autoSize={{ minRows: 4, maxRows: 10 }} maxLength={32768} />
      <Space>
        <Button type="primary" loading={busy} disabled={!selected || !input.trim()} onClick={() => void send()}>发送</Button>
        {busy && <Button onClick={() => requestId && void ofs.invoke('ai:cancel', requestId)}>停止生成</Button>}
        <Button onClick={() => setAnswer('')}>清空回答</Button>
      </Space>
    </Space>
  </Modal>
}
