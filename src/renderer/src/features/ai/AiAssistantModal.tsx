import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Input, List, Modal, Select, Space, Tag } from 'antd'
import { useUiStore } from '@/stores/useUiStore'
import { ofs } from '@/ipc/api'
import type { AiProviderProfile } from '@shared/types'

export function AiAssistantModal(): React.JSX.Element {
  const open = useUiStore((s) => s.aiOpen)
  const setOpen = useUiStore((s) => s.setAiOpen)
  const aiPrefill = useUiStore((s) => s.aiPrefill)
  const [profiles, setProfiles] = useState<AiProviderProfile[]>([])
  const [selected, setSelected] = useState<string>()
  const [input, setInput] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [model, setModel] = useState('gpt-4o-mini')
  const [name, setName] = useState('OpenAI')
  const [requestId, setRequestId] = useState<string>()
  useEffect(() => { if (open && aiPrefill) setInput(aiPrefill) }, [open, aiPrefill])

  useEffect(() => {
    if (!open) return
    void ofs.invoke('ai:profiles:list').then((items) => {
      setProfiles(items); const first = items[0]; if (first) { setSelected(first.id); setName(first.name); setBaseUrl(first.baseUrl); setModel(first.model) }
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [open])

  useEffect(() => {
    const disposers = [
      ofs.on('ai:delta', (e) => { if (e.requestId === requestId) setAnswer((v) => v + e.text) }),
      ofs.on('ai:completed', (e) => { if (e.requestId === requestId) setBusy(false) }),
      ofs.on('ai:cancelled', (e) => { if (e.requestId === requestId) setBusy(false) }),
      ofs.on('ai:error', (e) => { if (e.requestId === requestId) { setBusy(false); setError(e.message) } })
    ]
    return () => disposers.forEach((dispose) => dispose())
  }, [requestId])

  const current = useMemo(() => profiles.find((p) => p.id === selected), [profiles, selected])
  const choose = (id: string): void => { const p = profiles.find((v) => v.id === id); if (!p) return; setSelected(id); setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model); setToken('') }
  const save = async (): Promise<void> => {
    try { const p = await ofs.invoke('ai:profiles:save', { id: selected, name, baseUrl, model, token: token || undefined }); setProfiles((all) => all.some((v) => v.id === p.id) ? all.map((v) => v.id === p.id ? p : v) : [...all, p]); setSelected(p.id); setToken(''); setError('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const send = async (): Promise<void> => {
    if (!selected || !input.trim()) return
    const id = crypto.randomUUID(); setRequestId(id); setAnswer(''); setError(''); setBusy(true)
    await ofs.invoke('ai:chat', { requestId: id, profileId: selected, messages: [{ role: 'user', content: input.trim() }] }).catch((e) => { setBusy(false); setError(e instanceof Error ? e.message : String(e)) })
  }
  const remove = async (): Promise<void> => {
    if (!selected) return
    await ofs.invoke('ai:profiles:delete', selected)
    const rest = profiles.filter((p) => p.id !== selected)
    setProfiles(rest)
    const next = rest[0]
    if (next) choose(next.id)
    else setSelected(undefined)
  }
  const clearToken = async (): Promise<void> => {
    if (!selected) return
    const p = await ofs.invoke('ai:profiles:save', { id: selected, name, baseUrl, model, clearToken: true })
    setProfiles((all) => all.map((v) => v.id === p.id ? p : v))
    setToken('')
  }
  return <Modal open={open} onCancel={() => setOpen(false)} footer={null} width={780} title="AI 助手">
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Select style={{ width: 180 }} value={selected} placeholder="选择服务" onChange={choose} options={profiles.map((p) => ({ value: p.id, label: p.name }))} />
        <Button onClick={() => { setSelected(undefined); setName('新 AI 服务'); setBaseUrl('https://'); setModel(''); setToken(''); setError('') }}>新建配置</Button>
        <Input style={{ width: 130 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="服务名称" />
        <Input style={{ width: 230 }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL" />
        <Input style={{ width: 160 }} value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型" />
        <Input.Password style={{ width: 190 }} value={token} onChange={(e) => setToken(e.target.value)} placeholder={current?.hasToken ? 'Token 已保存，输入以替换' : 'API Token'} autoComplete="new-password" />
        <Button onClick={() => void save()}>保存配置</Button>
        <Button disabled={!selected} onClick={() => selected && void ofs.invoke('ai:connectionTest', { profileId: selected }).then(() => setError('连接测试成功')).catch((e) => setError(e instanceof Error ? e.message : String(e)))}>测试连接</Button>
        <Button danger disabled={!selected || profiles.length < 2} onClick={() => void remove()}>删除配置</Button>
        <Button disabled={!current?.hasToken} onClick={() => void clearToken()}>清除 Token</Button>
        {current?.hasToken && <Tag color="green">Token 已保存</Tag>}
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      <List bordered dataSource={answer ? [answer] : []} renderItem={(item) => <List.Item style={{ whiteSpace: 'pre-wrap', minHeight: 120 }}>{item}</List.Item>} />
      <Input.TextArea value={input} onChange={(e) => setInput(e.target.value)} placeholder="输入问题；终端文本只能由你主动粘贴或发送" autoSize={{ minRows: 3, maxRows: 8 }} maxLength={32768} />
      <Space>
        <Button type="primary" loading={busy} disabled={!selected || !input.trim()} onClick={() => void send()}>发送</Button>
        {busy && <Button onClick={() => requestId && void ofs.invoke('ai:cancel', requestId)}>停止生成</Button>}
        <Button onClick={() => setAnswer('')}>清空回答</Button>
      </Space>
    </Space>
  </Modal>
}
