import { useEffect, useMemo, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Collapse,
  Drawer,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Switch
} from 'antd'
import { useTranslation } from 'react-i18next'
import { PRESET_COLORS } from '@shared/constants'
import type { ProfileDraft } from '@shared/types'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSavedRefStore } from '@/stores/useSavedRefStore'
import { useUiStore } from '@/stores/useUiStore'
import { PrivateKeyEditModal, ProxyEditModal } from '@/features/settings/SavedRefModals'

interface FormValues {
  name: string
  groupId: string | null
  color?: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey' | 'agent'
  password?: string
  /** 引用一条已保存的私钥。路径与口令都归那条记录 */
  privateKeyId?: string
  charset: string
  termType: string
  startupCommand?: string
  keepaliveInterval: number
  readyTimeout: number
  legacyAlgorithms: boolean
  compress: boolean
  monitorEnabled: boolean
  /** 引用一条已保存的代理；空 = 直连 */
  proxyId?: string
  note?: string
}

export function ProfileEditDrawer(): React.JSX.Element {
  const { t } = useTranslation()
  const { message, modal } = AntdApp.useApp()
  const editingId = useUiStore((s) => s.editingProfileId)
  const setEditing = useUiStore((s) => s.setEditingProfile)
  const { profiles, groups, save } = useConnectionStore()
  const [form] = Form.useForm<FormValues>()
  const [saving, setSaving] = useState(false)
  const proxies = useSavedRefStore((s) => s.proxies)
  const keys = useSavedRefStore((s) => s.keys)
  const refsLoaded = useSavedRefStore((s) => s.loaded)
  const loadRefs = useSavedRefStore((s) => s.load)
  /** 'new' 或一条现有记录；从下拉框底部的「新建…」进来 */
  const [editingProxy, setEditingProxy] = useState<'new' | null>(null)
  const [editingKey, setEditingKey] = useState<'new' | null>(null)

  const editing = useMemo(
    () => (editingId && editingId !== 'new' ? profiles.find((p) => p.id === editingId) : undefined),
    [editingId, profiles]
  )
  const open = editingId !== null
  const hasSavedPassword = Boolean(editing?.auth.passwordRef)

  useEffect(() => {
    if (open && !refsLoaded) void loadRefs()
  }, [open, refsLoaded, loadRefs])

  useEffect(() => {
    if (!open) return
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        groupId: editing.groupId,
        color: editing.color,
        host: editing.host,
        port: editing.port,
        username: editing.username,
        authMethod: editing.auth.method,
        password: '',
        privateKeyId: editing.auth.privateKeyId,
        charset: editing.terminal.charset,
        termType: editing.terminal.termType,
        startupCommand: editing.terminal.startupCommand,
        keepaliveInterval: editing.options.keepaliveInterval,
        readyTimeout: editing.options.readyTimeout,
        legacyAlgorithms: editing.options.legacyAlgorithms,
        compress: editing.options.compress,
        monitorEnabled: editing.options.monitorEnabled,
        proxyId: editing.proxyId,
        note: editing.note
      })
    } else {
      form.resetFields()
    }
  }, [open, editing, form])

  const close = (): void => {
    if (form.isFieldsTouched()) {
      modal.confirm({
        title: t('conn.discardChanges'),
        okText: t('common.ok'),
        cancelText: t('common.cancel'),
        onOk: () => setEditing(null)
      })
    } else {
      setEditing(null)
    }
  }

  const submit = async (): Promise<void> => {
    await form.validateFields()
    // 必须取整个 store，不能用 validateFields() 的返回值：
    // 后者只含"已挂载"的字段，而折叠面板（高级选项 / 代理）没被展开过时里面的
    // Form.Item 根本没挂载 —— 取到的全是 undefined，主进程 zod 直接拒收。
    // initialValues / setFieldsValue 写入的值在 store 里始终存在，与挂载状态无关。
    const v = form.getFieldsValue(true) as FormValues
    setSaving(true)
    try {
      const draft: ProfileDraft = {
        id: editing?.id,
        name: v.name.trim(),
        groupId: v.groupId ?? null,
        color: v.color,
        host: v.host.trim(),
        port: v.port,
        username: v.username.trim(),
        auth: {
          method: v.authMethod,
          password: v.password || undefined,
          privateKeyId: v.privateKeyId || undefined
        },
        terminal: {
          charset: v.charset,
          termType: v.termType,
          startupCommand: v.startupCommand || undefined
        },
        options: {
          keepaliveInterval: v.keepaliveInterval,
          readyTimeout: v.readyTimeout,
          legacyAlgorithms: v.legacyAlgorithms,
          autoReconnect: editing?.options.autoReconnect ?? true,
          monitorEnabled: v.monitorEnabled,
          compress: v.compress
        },
        proxyId: v.proxyId || undefined,
        note: v.note || undefined
      }
      await save(draft)
      message.success(t('conn.saved'))
      setEditing(null)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      title={editing ? t('conn.editTitle', { name: editing.name }) : t('sidebar.newConnection')}
      width={520}
      open={open}
      onClose={close}
      destroyOnHidden
      /*
       * 从标题栏下方开始，不要顶到窗口顶端。
       * Windows 的原生窗口按钮（titleBarOverlay）由 OS 绘制、永远盖在页面之上，
       * 抽屉顶上去的话头部的"取消/保存"会被压住，右上角还会糊出一块标题栏底色的方块。
       */
      rootStyle={{ top: 'var(--ofs-titlebar-height)' }}
      extra={
        <Space>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button type="primary" loading={saving} onClick={() => void submit()}>
            {t('common.save')}
          </Button>
        </Space>
      }
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          groupId: null,
          port: 22,
          authMethod: 'password',
          charset: 'utf-8',
          termType: 'xterm-256color',
          keepaliveInterval: 15000,
          readyTimeout: 15000,
          legacyAlgorithms: false,
          compress: false,
          // 必须在 initialValues 里：折叠面板没展开过时 Form.Item 不挂载，
          // 只有 initialValues 写进 store 的值才拿得到（见 submit 里的注释）
          monitorEnabled: true
        }}
      >
        <Form.Item name="name" label={t('conn.name')} rules={[{ required: true, message: t('conn.nameRequired') }]}>
          <Input placeholder={t('conn.namePlaceholder')} />
        </Form.Item>

        <Space.Compact block>
          <Form.Item
            name="host"
            label={t('conn.host')}
            style={{ flex: 1 }}
            rules={[{ required: true, message: t('conn.hostRequired') }]}
          >
            <Input placeholder="192.168.1.100 / example.com" />
          </Form.Item>
          <Form.Item name="port" label={t('conn.port')} style={{ width: 110, marginLeft: 8 }}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
        </Space.Compact>

        <Form.Item
          name="username"
          label={t('conn.username')}
          rules={[{ required: true, message: t('conn.usernameRequired') }]}
        >
          <Input placeholder="root" />
        </Form.Item>

        <Form.Item name="authMethod" label={t('conn.authMethod')}>
          <Radio.Group
            optionType="button"
            options={[
              { label: t('conn.authPassword'), value: 'password' },
              { label: t('conn.authPrivateKey'), value: 'privateKey' },
              { label: 'SSH Agent', value: 'agent' }
            ]}
          />
        </Form.Item>

        <Form.Item noStyle shouldUpdate={(a, b) => a.authMethod !== b.authMethod}>
          {({ getFieldValue }) => {
            const method = getFieldValue('authMethod')
            if (method === 'password') {
              return (
                <Form.Item
                  name="password"
                  label={t('conn.password')}
                  extra={hasSavedPassword ? t('conn.passwordSavedHint') : t('conn.passwordEmptyHint')}
                >
                  <Input.Password placeholder={hasSavedPassword ? '••••••••' : ''} />
                </Form.Item>
              )
            }
            if (method === 'privateKey') {
              const picked = keys.find((k) => k.id === form.getFieldValue('privateKeyId'))
              return (
                <>
                  <Form.Item
                    name="privateKeyId"
                    label={t('conn.privateKey')}
                    rules={[{ required: true, message: t('conn.privateKeyRequired') }]}
                    extra={
                      picked ? (
                        // 选中之后把路径与"口令已存"弱化显示出来：下拉框里只有名字，
                        // 而用户要确认的是"这条到底指着哪个文件"
                        <span className="ofs-dim">
                          {picked.path}
                          {picked.passphraseRef ? ` · ${t('conn.passphraseSaved')}` : ''}
                        </span>
                      ) : (
                        t('conn.privateKeyPickHint')
                      )
                    }
                  >
                    <Select
                      placeholder={t('conn.privateKeySelect')}
                      options={keys.map((k) => ({ label: k.name, value: k.id }))}
                      popupRender={(menu) => (
                        <>
                          {menu}
                          <div className="ofs-select-footer">
                            <a onClick={() => setEditingKey('new')}>{t('conn.privateKeyNew')}</a>
                          </div>
                        </>
                      )}
                    />
                  </Form.Item>
                </>
              )
            }
            return null
          }}
        </Form.Item>

        <Form.Item name="groupId" label={t('conn.group')}>
          <Select
            allowClear
            placeholder={t('conn.noGroup')}
            options={groups.map((g) => ({ label: g.name, value: g.id }))}
          />
        </Form.Item>

        <Form.Item name="color" label={t('conn.color')}>
          <Radio.Group>
            {PRESET_COLORS.map((c) => (
              <Radio key={c} value={c}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: c,
                    verticalAlign: 'middle'
                  }}
                />
              </Radio>
            ))}
          </Radio.Group>
        </Form.Item>

        <Collapse
          ghost
          items={[
            {
              key: 'advanced',
              label: t('conn.advanced'),
              children: (
                <>
                  <Form.Item name="charset" label={t('conn.charset')}>
                    <Select
                      options={[
                        { value: 'utf-8', label: 'UTF-8' },
                        { value: 'gbk', label: 'GBK' },
                        { value: 'gb18030', label: 'GB18030' },
                        { value: 'big5', label: 'Big5' },
                        { value: 'euc-jp', label: 'EUC-JP' }
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="termType" label={t('conn.termType')}>
                    <Select
                      options={['xterm-256color', 'xterm', 'vt100', 'linux'].map((v) => ({
                        value: v,
                        label: v
                      }))}
                    />
                  </Form.Item>
                  <Form.Item name="startupCommand" label={t('conn.startupCommand')}>
                    <Input.TextArea rows={2} placeholder={t('conn.startupCommandPlaceholder')} />
                  </Form.Item>
                  <Space size="large">
                    <Form.Item name="keepaliveInterval" label={t('conn.keepalive')}>
                      <InputNumber min={0} max={600000} step={1000} addonAfter="ms" />
                    </Form.Item>
                    <Form.Item name="readyTimeout" label={t('conn.timeout')}>
                      <InputNumber min={1000} max={120000} step={1000} addonAfter="ms" />
                    </Form.Item>
                  </Space>
                  <Space size="large">
                    <Form.Item
                      name="legacyAlgorithms"
                      label={t('conn.legacyAlgorithms')}
                      valuePropName="checked"
                      tooltip={t('conn.legacyAlgorithmsTip')}
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item name="compress" label={t('conn.compress')} valuePropName="checked">
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      name="monitorEnabled"
                      label={t('conn.monitorEnabled')}
                      valuePropName="checked"
                      tooltip={t('conn.monitorEnabledTip')}
                    >
                      <Switch />
                    </Form.Item>
                  </Space>
                  <Form.Item name="note" label={t('conn.note')}>
                    <Input.TextArea rows={2} />
                  </Form.Item>
                </>
              )
            },
            {
              key: 'proxy',
              label: t('conn.proxy'),
              children: (
                <>
                  {/* 包一层 shouldUpdate：extra 里要显示选中那条代理的地址，
                      而 Collapse 的 children 是在组件体里构造的，不包就不会随选择变化重渲染 */}
                  <Form.Item noStyle shouldUpdate={(a, b) => a.proxyId !== b.proxyId}>
                    {({ getFieldValue }) => {
                      const pickedProxy = proxies.find((x) => x.id === getFieldValue('proxyId'))
                      return (
                  <Form.Item
                    name="proxyId"
                    label={t('conn.proxy')}
                    extra={
                      pickedProxy ? (
                        <span className="ofs-dim">
                          {pickedProxy.type.toUpperCase()} {pickedProxy.host}:{pickedProxy.port}
                          {pickedProxy.username ? ` · ${pickedProxy.username}` : ''}
                          {pickedProxy.passwordRef ? ` · ${t('conn.passwordSaved')}` : ''}
                        </span>
                      ) : (
                        t('conn.proxyHint')
                      )
                    }
                  >
                    <Select
                      allowClear
                      placeholder={t('conn.proxyNone')}
                      options={proxies.map((x) => ({
                        label: `${x.name}（${x.type.toUpperCase()} ${x.host}:${x.port}）`,
                        value: x.id
                      }))}
                      popupRender={(menu) => (
                        <>
                          {menu}
                          <div className="ofs-select-footer">
                            <a onClick={() => setEditingProxy('new')}>{t('conn.proxyNew')}</a>
                          </div>
                        </>
                      )}
                    />
                  </Form.Item>
                      )
                    }}
                  </Form.Item>
                </>
              )
            }
          ]}
        />
      </Form>

      {/* 新建代理/私钥：与设置页共用同一份弹窗；存完顺手选上，用户不用再回下拉框里挑一次 */}
      {editingProxy && (
        <ProxyEditModal
          target={editingProxy}
          onClose={() => setEditingProxy(null)}
          onSaved={(id) => form.setFieldValue('proxyId', id)}
        />
      )}
      {editingKey && (
        <PrivateKeyEditModal
          target={editingKey}
          onClose={() => setEditingKey(null)}
          onSaved={(id) => form.setFieldValue('privateKeyId', id)}
        />
      )}
    </Drawer>
  )
}
