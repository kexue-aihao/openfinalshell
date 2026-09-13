import { useEffect, useState } from 'react'
import { Alert, Button, Card, Input, List, Select, Space, Switch, Tag, Typography } from 'antd'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { ofs } from '@/ipc/api'
import type { AiModelInfo, AiProviderProfile } from '@shared/types'
import styles from './AiSettingsPanel.module.css'

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
  const [models, setModels] = useState<AiModelInfo[]>([])
  const [discovering, setDiscovering] = useState(false)

  const load = (): void => {
    void ofs.invoke('ai:profiles:list').then((items) => {
      setProfiles(items)
      const p = items.find((v) => v.id === selected) ?? items[0]
      if (p) { setSelected(p.id); setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model) }
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])
  const choose = (id: string): void => { const p = profiles.find((v) => v.id === id); if (!p) return; setSelected(id); setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model); setToken(''); setModels([]); setError(''); setNotice('') }
  const save = async (): Promise<void> => {
    try { const p = await ofs.invoke('ai:profiles:save', { id: selected, name, baseUrl, model, token: token || undefined }); setProfiles((all) => all.some((v) => v.id === p.id) ? all.map((v) => v.id === p.id ? p : v) : [...all, p]); setSelected(p.id); setToken(''); setNotice('配置已保存'); setError('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const create = (): void => { setSelected(undefined); setName('新 AI 服务'); setBaseUrl('https://'); setModel(''); setToken(''); setModels([]); setError(''); setNotice('') }
  const remove = async (): Promise<void> => { if (!selected || profiles.length < 2) return; await ofs.invoke('ai:profiles:delete', selected); load() }
  const test = async (): Promise<void> => { if (!selected) return; try { await ofs.invoke('ai:connectionTest', { profileId: selected }); setNotice('连接测试成功'); setError('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }
  const clear = async (): Promise<void> => { if (!selected) return; try { const p = await ofs.invoke('ai:profiles:save', { id: selected, name, baseUrl, model, clearToken: true }); setProfiles((all) => all.map((v) => v.id === p.id ? p : v)); setToken(''); setNotice('Token 已清除') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }
  const discover = async (): Promise<void> => {
    if (!baseUrl.trim() || (!token.trim() && !profiles.find((p) => p.id === selected)?.hasToken)) { setError('请先填写 API 地址和 Token，再获取模型列表'); return }
    setDiscovering(true); setError(''); setNotice('')
    try {
      const result = await ofs.invoke('ai:models:discover', { profileId: selected, baseUrl, token: token || undefined })
      setModels(result)
      setNotice(`已获取 ${result.length} 个可用模型`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setDiscovering(false) }
  }
  const selectedModelInfo = models.find((item) => item.id === model)
  const modelOptions = models.map((item) => ({
    value: item.id,
    label: <Space size={6}><span>{item.name === item.id ? item.id : `${item.name} (${item.id})`}</span><Tag color={item.input.image === 'yes' ? 'blue' : item.input.image === 'no' ? 'default' : 'gold'}>{item.input.image === 'yes' ? '图片' : item.input.image === 'no' ? '文本' : '能力未知'}</Tag></Space>,
    searchText: `${item.name} ${item.id}`.toLowerCase()
  }))
  if (model && !models.some((item) => item.id === model)) {
    modelOptions.unshift({ value: model, label: <Space size={6}><span>{model}（当前配置）</span><Tag color="gold">能力未知</Tag></Space>, searchText: model.toLowerCase() })
  }
  if (!settings) return <></>
  return <Space direction="vertical" style={{ width: '100%' }} size="middle">
    <Card size="small" title="AI 助手总开关" extra={<Switch checked={settings.aiAssistantEnabled} onChange={(v) => patch({ aiAssistantEnabled: v })} />}>
      启用后，SSH 终端工具栏和左侧工具栏会显示 AI 入口。终端内容只有在你主动发送时才会提交。
    </Card>
    <section className={styles.editor} aria-label="AI 服务配置编辑">
      <div className={styles.editorHeader}>
        <div>
          <Typography.Text strong>服务配置</Typography.Text>
          <Typography.Text type="secondary" className={styles.editorHint}>选择已有配置，或新建一个兼容 OpenAI 协议的服务</Typography.Text>
        </div>
        <Space>
          <Button onClick={create}>新建配置</Button>
          <Button loading={discovering} disabled={!baseUrl.trim()} onClick={() => void discover()}>获取模型</Button>
        </Space>
      </div>
      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span className={styles.label}>配置</span>
          <Select
            value={selected}
            placeholder="选择服务配置"
            onChange={choose}
            options={profiles.map((p) => ({ value: p.id, label: p.name }))}
            notFoundContent="暂无配置"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>配置名称</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：公司 AI" />
        </label>
        <label className={`${styles.field} ${styles.wideField}`}>
          <span className={styles.label}>Base URL</span>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
        </label>
        <div className={styles.field}>
          <label htmlFor="ai-settings-model" className={styles.label}>模型</label>
          {models.length > 0 ? (
            <Select
              id="ai-settings-model"
              value={model || undefined}
              onChange={setModel}
              showSearch
              options={modelOptions}
              filterOption={(input, option) => String(option?.searchText ?? '').includes(input.toLowerCase())}
              placeholder="请选择已获取的模型"
              notFoundContent="没有匹配的模型"
              style={{ width: '100%' }}
            />
          ) : (
            <Input id="ai-settings-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如：gpt-4o-mini（也可手动填写）" />
          )}
          {models.length > 0 && <Typography.Text type="secondary" className={styles.modelHint}>已获取 {models.length} 个模型，可下拉选择或搜索，选择后点击“保存配置”。{model && !selectedModelInfo && '当前模型未在返回列表中，仍保留原值。'}</Typography.Text>}
          {selectedModelInfo && <Space size={4} className={styles.capabilities}><Tag color="green">文本输入</Tag><Tag color={selectedModelInfo.input.image === 'yes' ? 'blue' : selectedModelInfo.input.image === 'no' ? 'default' : 'gold'}>{selectedModelInfo.input.image === 'yes' ? '支持图片' : selectedModelInfo.input.image === 'no' ? '不支持图片' : '图片能力未知'}</Tag>{selectedModelInfo.contextWindow && <Tag>{selectedModelInfo.contextWindow.toLocaleString()} 上下文</Tag>}</Space>}
        </div>
      </div>
      <div className={styles.tokenRow}>
        <label className={`${styles.field} ${styles.tokenField}`}>
          <span className={styles.label}>API Token</span>
          <Input.Password value={token} onChange={(e) => setToken(e.target.value)} placeholder="留空表示保持当前 Token" autoComplete="new-password" />
        </label>
        {selected && profiles.find((p) => p.id === selected)?.hasToken && <Tag color="green" className={styles.tokenStatus}>Token 已保存</Tag>}
      </div>
      <Space wrap className={styles.actions}>
        <Button type="primary" onClick={() => void save()}>保存配置</Button>
        <Button onClick={() => void test()} disabled={!selected}>测试连接</Button>
        <Button onClick={() => void clear()} disabled={!selected || !profiles.find((p) => p.id === selected)?.hasToken}>清除 Token</Button>
        <Button danger onClick={() => void remove()} disabled={!selected || profiles.length < 2}>删除配置</Button>
      </Space>
    </section>
    {notice && <Alert type="success" showIcon message={notice} />}
    {error && <Alert type="error" showIcon message={error} />}
    <List bordered size="small" dataSource={profiles} renderItem={(p) => <List.Item actions={[<Button key="use" type={p.id === selected ? 'primary' : 'link'} onClick={() => choose(p.id)}>{p.id === selected ? '当前配置' : '选择'}</Button>]}><List.Item.Meta title={p.name} description={`${p.baseUrl} · ${p.model}`} /></List.Item>} />
  </Space>
}
