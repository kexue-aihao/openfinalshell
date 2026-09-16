import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Card, Input, List, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { ofs } from '@/ipc/api'
import type { AiImageCapabilityTestResult, AiModelInfo, AiProviderProfile } from '@shared/types'
import styles from './AiSettingsPanel.module.css'

function ImageCapabilityTag({ info, tested }: { info?: AiModelInfo; tested?: AiImageCapabilityTestResult }): React.JSX.Element {
  const { t } = useTranslation()
  if (tested && tested.image !== 'unknown') {
    return <Tooltip title={tested.message}><Tag color={tested.image === 'yes' ? 'blue' : undefined}>{tested.image === 'yes' ? t('aiCapabilities.requestAccepted') : t('aiCapabilities.rejectedLabel')}</Tag></Tooltip>
  }
  const image = info?.input.image ?? 'unknown'
  const title = image === 'unknown'
    ? t('aiCapabilities.unknownHint')
    : t('aiCapabilities.declaredHint')
  return <Tooltip title={title}><Tag color={image === 'yes' ? 'blue' : undefined}>{image === 'yes' ? t('aiCapabilities.declaredImage') : image === 'no' ? t('aiCapabilities.declaredNoImage') : t('aiCapabilities.undeclared')}</Tag></Tooltip>
}

export function AiSettingsPanel(): React.JSX.Element {
  const { t } = useTranslation()
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
  const [testingImage, setTestingImage] = useState(false)
  const [testingConnection, setTestingConnection] = useState(false)
  const [imageTests, setImageTests] = useState<Record<string, AiImageCapabilityTestResult>>({})
  const endpointRevision = useRef(0)
  const probeRevision = useRef(0)
  const connectionRevision = useRef(0)
  const draftRevision = useRef<number>()

  const invalidateConnection = (): void => {
    connectionRevision.current++
    setTestingConnection(false)
    setError(''); setNotice('')
  }

  const invalidateEndpoint = (): void => {
    invalidateConnection()
    endpointRevision.current++; probeRevision.current++
    setModels([]); setImageTests({}); setDiscovering(false); setTestingImage(false)
    setError(''); setNotice('')
  }
  const chooseModel = (value: string): void => {
    invalidateConnection()
    probeRevision.current++; setTestingImage(false); setModel(value); setError(''); setNotice('')
  }
  useEffect(() => () => { endpointRevision.current++; probeRevision.current++; connectionRevision.current++ }, [])

  const load = (): void => {
    void ofs.invoke('ai:profiles:list').then((items) => {
      setProfiles(items)
      const p = items.find((v) => v.id === selected) ?? items[0]
      if (p) { draftRevision.current = p.updatedAt; setSelected(p.id); setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model) }
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])
  useEffect(() => {
    const refresh = (): void => { void ofs.invoke('ai:profiles:list').then(setProfiles).catch(() => {}) }
    const off = ofs.on('app:configChanged', (e) => { if (e.entity === 'ai') refresh() })
    window.addEventListener('focus', refresh)
    const timer = setInterval(refresh, 30_000)
    return () => { off(); window.removeEventListener('focus', refresh); clearInterval(timer) }
  }, [])
  const choose = (id: string): void => { const p = profiles.find((v) => v.id === id); if (!p) return; draftRevision.current = p.updatedAt; invalidateEndpoint(); setSelected(id); setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model); setToken('') }
  const save = async (): Promise<void> => {
    invalidateConnection()
    try {
      const p = await ofs.invoke('ai:profiles:save', { id: selected, expectedUpdatedAt: selected ? draftRevision.current : undefined, name, baseUrl, model, token: token || undefined })
      draftRevision.current = p.updatedAt
      setProfiles((all) => all.some((v) => v.id === p.id) ? all.map((v) => v.id === p.id ? p : v) : [...all, p])
      setSelected(p.id); setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model); setToken('')
      setNotice('配置已保存'); setError('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const create = (): void => { invalidateEndpoint(); setSelected(undefined); setName('新 AI 服务'); setBaseUrl('https://'); setModel(''); setToken('') }
  const remove = async (): Promise<void> => { if (!selected || profiles.length < 2) return; await ofs.invoke('ai:profiles:delete', selected); load() }
  const test = async (): Promise<void> => {
    if (!selected || testingConnection) return
    const saved = profiles.find((p) => p.id === selected)
    if (!saved || baseUrl.trim() !== saved.baseUrl || model.trim() !== saved.model || token.trim()) {
      setNotice(''); setError(t('aiConnectionTest.saveFirst')); return
    }
    const revision = ++connectionRevision.current
    setTestingConnection(true); setNotice(''); setError('')
    try {
      const result = await ofs.invoke('ai:connectionTest', { profileId: selected })
      if (revision === connectionRevision.current) {
        setNotice(t('aiConnectionTest.success', { latencyMs: result.latencyMs }))
      }
    } catch (e) {
      if (revision === connectionRevision.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (revision === connectionRevision.current) setTestingConnection(false)
    }
  }
  const clear = async (): Promise<void> => { if (!selected) return; try { const p = await ofs.invoke('ai:profiles:save', { id: selected, expectedUpdatedAt: draftRevision.current, name, baseUrl, model, clearToken: true }); draftRevision.current = p.updatedAt; setProfiles((all) => all.map((v) => v.id === p.id ? p : v)); setToken(''); setNotice('Token 已清除') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }
  const discover = async (): Promise<void> => {
    if (!baseUrl.trim() || (!token.trim() && !profiles.find((p) => p.id === selected)?.hasToken)) { setError('请先填写 API 地址和 Token，再获取模型列表'); return }
    const revision = ++endpointRevision.current
    setDiscovering(true); setError(''); setNotice('')
    try {
      const result = await ofs.invoke('ai:models:discover', { profileId: selected, baseUrl, token: token || undefined })
      if (revision !== endpointRevision.current) return
      setModels(result)
      setNotice(`已获取 ${result.length} 个可用模型`)
    } catch (e) { if (revision === endpointRevision.current) setError(e instanceof Error ? e.message : String(e)) } finally { if (revision === endpointRevision.current) setDiscovering(false) }
  }
  const testImage = async (): Promise<void> => {
    if (!model.trim()) return
    const revision = ++probeRevision.current
    setTestingImage(true); setError(''); setNotice('')
    try {
      const result = await ofs.invoke('ai:model:capabilityTest', { profileId: selected, baseUrl, token: token || undefined, model })
      if (revision !== probeRevision.current) return
      setImageTests((previous) => ({ ...previous, [result.model]: result }))
    } catch (e) {
      if (revision === probeRevision.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (revision === probeRevision.current) setTestingImage(false)
    }
  }
  const selectedModelInfo = models.find((item) => item.id === model.trim())
  const imageTest = imageTests[model.trim()]
  const modelOptions = models.map((item) => ({
    value: item.id,
    label: item.name === item.id ? item.id : `${item.name} (${item.id})`,
    info: item as AiModelInfo | undefined,
    searchText: `${item.name} ${item.id}`.toLowerCase()
  }))
  if (model && !models.some((item) => item.id === model)) {
    modelOptions.unshift({ value: model, label: `${model}（当前配置）`, info: undefined, searchText: model.toLowerCase() })
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
          <Button loading={discovering} disabled={!baseUrl.trim() || testingImage || testingConnection} onClick={() => void discover()}>获取模型</Button>
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
          <Input value={baseUrl} onChange={(e) => { invalidateEndpoint(); setBaseUrl(e.target.value) }} placeholder="https://api.openai.com/v1" />
        </label>
        <div className={styles.field}>
          <label htmlFor="ai-settings-model" className={styles.label}>模型</label>
          {models.length > 0 ? (
            <Select
              id="ai-settings-model"
              value={model || undefined}
              onChange={chooseModel}
              showSearch
              options={modelOptions}
              optionRender={(option) => <div className={styles.modelOption}><span>{option.label}</span><ImageCapabilityTag info={option.data.info} tested={imageTests[String(option.value)]} /></div>}
              filterOption={(input, option) => String(option?.searchText ?? '').includes(input.toLowerCase())}
              placeholder="请选择已获取的模型"
              notFoundContent="没有匹配的模型"
              style={{ width: '100%' }}
            />
          ) : (
            <Input id="ai-settings-model" value={model} onChange={(e) => chooseModel(e.target.value)} placeholder="例如：gpt-4o-mini（也可手动填写）" />
          )}
          {models.length > 0 && <Typography.Text type="secondary" className={styles.modelHint}>已获取 {models.length} 个模型，可下拉选择或搜索，选择后点击“保存配置”。{model && !selectedModelInfo && '当前模型未在返回列表中，仍保留原值。'}</Typography.Text>}
          {model && <Space wrap size={4} className={styles.capabilities}><ImageCapabilityTag info={selectedModelInfo} tested={imageTest} />{selectedModelInfo?.contextWindow && <Tag>{selectedModelInfo.contextWindow.toLocaleString()} 上下文</Tag>}</Space>}
        </div>
      </div>
      <div className={styles.tokenRow}>
        <label className={`${styles.field} ${styles.tokenField}`}>
          <span className={styles.label}>API Token</span>
          <Input.Password value={token} onChange={(e) => { invalidateEndpoint(); setToken(e.target.value) }} placeholder="留空表示保持当前 Token" autoComplete="new-password" />
        </label>
        {selected && profiles.find((p) => p.id === selected)?.hasToken && <Tag color="green" className={styles.tokenStatus}>Token 已保存</Tag>}
      </div>
      <div className={styles.imageTest}>
        <Typography.Text type="secondary">{t('aiCapabilities.testHint')}</Typography.Text>
        <Button loading={testingImage} disabled={discovering || testingConnection || !settings.aiAssistantEnabled || !model.trim() || !baseUrl.trim() || (!token.trim() && !profiles.find((p) => p.id === selected)?.hasToken)} onClick={() => void testImage()}>{t('aiCapabilities.testButton')}</Button>
        {imageTest && <Alert showIcon type={imageTest.outcome === 'accepted' ? 'success' : 'info'} message={imageTest.message} />}
      </div>
      <Space wrap className={styles.actions}>
        <Button type="primary" disabled={discovering || testingImage || testingConnection} onClick={() => void save()}>保存配置</Button>
        <Tooltip title={t('aiConnectionTest.hint')}>
          <Button loading={testingConnection} onClick={() => void test()} disabled={!selected || !settings.aiAssistantEnabled || discovering || testingImage}>{t('aiConnectionTest.button')}</Button>
        </Tooltip>
        <Button onClick={() => { invalidateEndpoint(); void clear() }} disabled={discovering || testingImage || testingConnection || !selected || !profiles.find((p) => p.id === selected)?.hasToken}>清除 Token</Button>
        <Button danger onClick={() => { invalidateEndpoint(); void remove() }} disabled={discovering || testingImage || testingConnection || !selected || profiles.length < 2}>删除配置</Button>
      </Space>
    </section>
    {notice && <Alert type="success" showIcon message={notice} />}
    {error && <Alert type="error" showIcon message={error} />}
    <List bordered size="small" dataSource={profiles} renderItem={(p) => <List.Item actions={[<Button key="use" type={p.id === selected ? 'primary' : 'link'} onClick={() => choose(p.id)}>{p.id === selected ? '当前配置' : '选择'}</Button>]}><List.Item.Meta title={p.name} description={`${p.baseUrl} · ${p.model}`} /></List.Item>} />
  </Space>
}
