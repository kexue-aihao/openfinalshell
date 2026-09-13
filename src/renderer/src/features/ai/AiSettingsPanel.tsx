import { useEffect, useState } from 'react'
import { Alert, Button, Card, Input, List, Space, Switch, Tag } from 'antd'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { ofs } from '@/ipc/api'
import type { AiProviderProfile } from '@shared/types'

export function AiSettingsPanel(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsStore((s) => s.patch)
  const [profiles, setProfiles] = useState<AiProviderProfile[]>([])
  const [selected, setSelected] = useState<string>()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = (): void => {
    void ofs.invoke('ai:profiles:list').then((items) => {
      setProfiles(items)
      const p = items.find((v) => v.id === selected) ?? items[0]
      if (p) { setSelected(p.id); setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model) }
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])
  const choose = (id: string): void => { const p = profiles.find((v) => v.id === id); if (!p) return; setSelected(id); setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model); setToken(''); setError(''); setNotice('') }
  const save = async (): Promise<void> => {
    try { const p = await ofs.invoke('ai:profiles:save', { id: selected, name, baseUrl, model, token: token || undefined }); setProfiles((all) => all.some((v) => v.id === p.id) ? all.map((v) => v.id === p.id ? p : v) : [...all, p]); setSelected(p.id); setToken(''); setNotice('配置已保存'); setError('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const create = (): void => { setSelected(undefined); setName('新 AI 服务'); setBaseUrl('https://'); setModel(''); setToken(''); setError(''); setNotice('') }
  const remove = async (): Promise<void> => { if (!selected || profiles.length < 2) return; await ofs.invoke('ai:profiles:delete', selected); load() }
  const test = async (): Promise<void> => { if (!selected) return; try { await ofs.invoke('ai:connectionTest', { profileId: selected }); setNotice('连接测试成功'); setError('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }
  const clear = async (): Promise<void> => { if (!selected) return; try { const p = await ofs.invoke('ai:profiles:save', { id: selected, name, baseUrl, model, clearToken: true }); setProfiles((all) => all.map((v) => v.id === p.id ? p : v)); setToken(''); setNotice('Token 已清除') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }
  if (!settings) return <></>
  return <Space direction="vertical" style={{ width: '100%' }} size="middle">
    <Card size="small" title="AI 助手总开关" extra={<Switch checked={settings.aiAssistantEnabled} onChange={(v) => patch({ aiAssistantEnabled: v })} />}>
      启用后，SSH 终端工具栏和左侧工具栏会显示 AI 入口。终端内容只有在你主动发送时才会提交。
    </Card>
    <Space wrap>
      <Button onClick={create}>新建配置</Button>
      <select value={selected ?? ''} onChange={(e) => choose(e.target.value)} style={{ minWidth: 170, height: 32 }}>
        <option value="">选择服务配置</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="服务名称" style={{ width: 150 }} />
      <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL" style={{ width: 260 }} />
      <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名称" style={{ width: 180 }} />
    </Space>
    <Space wrap>
      <Input.Password value={token} onChange={(e) => setToken(e.target.value)} placeholder="API Token（留空保持不变）" style={{ width: 300 }} autoComplete="new-password" />
      <Button type="primary" onClick={() => void save()}>保存配置</Button>
      <Button onClick={() => void test()} disabled={!selected}>测试连接</Button>
      <Button onClick={() => void clear()} disabled={!selected || !profiles.find((p) => p.id === selected)?.hasToken}>清除 Token</Button>
      <Button danger onClick={() => void remove()} disabled={!selected || profiles.length < 2}>删除配置</Button>
      {selected && profiles.find((p) => p.id === selected)?.hasToken && <Tag color="green">Token 已保存</Tag>}
    </Space>
    {notice && <Alert type="success" showIcon message={notice} />}
    {error && <Alert type="error" showIcon message={error} />}
    <List bordered size="small" dataSource={profiles} renderItem={(p) => <List.Item actions={[<Button key="use" type={p.id === selected ? 'primary' : 'link'} onClick={() => choose(p.id)}>{p.id === selected ? '当前配置' : '选择'}</Button>]}><List.Item.Meta title={p.name} description={`${p.baseUrl} · ${p.model}`} /></List.Item>} />
  </Space>
}
