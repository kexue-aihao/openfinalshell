import { useEffect } from 'react'
import { App as AntdApp, Form, Input, InputNumber, Modal, Radio, Space } from 'antd'
import { useTranslation } from 'react-i18next'
import type { SavedPrivateKey, SavedProxy } from '@shared/types'
import { ofs } from '@/ipc/api'
import { useSavedRefStore } from '@/stores/useSavedRefStore'

/**
 * 代理与私钥的新建/编辑弹窗。**连接编辑抽屉与设置页共用这一份** ——
 * 两处各写一遍表单，迟早会出现"抽屉里能填的字段设置页里填不了"。
 *
 * 口令类字段的规矩与连接抽屉完全一致：回填时一律置空串，`extra` 说明"留空表示保持不变"，
 * 因为已保存的密码永远不会回传渲染进程（只有一个 Vault 引用）。
 */

interface ProxyProps {
  /** 'new' = 新建；否则是要编辑的那条 */
  target: 'new' | SavedProxy
  onClose: () => void
  /** 保存成功后回传 id，调用方可以顺手把它选上 */
  onSaved?: (id: string) => void
}

interface ProxyValues {
  name: string
  type: 'http' | 'socks5'
  host: string
  port: number
  username?: string
  password?: string
}

export function ProxyEditModal({ target, onClose, onSaved }: ProxyProps): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm<ProxyValues>()
  const saveProxy = useSavedRefStore((s) => s.saveProxy)
  const editing = target === 'new' ? undefined : target

  useEffect(() => {
    form.setFieldsValue({
      name: editing?.name ?? '',
      type: editing?.type ?? 'socks5',
      host: editing?.host ?? '127.0.0.1',
      port: editing?.port ?? 7890,
      username: editing?.username ?? '',
      password: ''
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const submit = async (): Promise<void> => {
    const v = await form.validateFields()
    try {
      const saved = await saveProxy({
        id: editing?.id,
        name: v.name.trim(),
        type: v.type,
        host: v.host.trim(),
        port: v.port,
        username: v.username?.trim() || undefined,
        password: v.password || undefined
      })
      onSaved?.(saved.id)
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Modal
      open
      title={editing ? t('savedRef.proxyEdit') : t('savedRef.proxyNew')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="name"
          label={t('savedRef.name')}
          rules={[{ required: true, message: t('savedRef.nameRequired') }]}
        >
          <Input placeholder={t('savedRef.proxyNamePlaceholder')} />
        </Form.Item>
        <Form.Item name="type" label={t('conn.proxyType')}>
          <Radio.Group
            optionType="button"
            options={[
              { label: 'HTTP', value: 'http' },
              { label: 'SOCKS5', value: 'socks5' }
            ]}
          />
        </Form.Item>
        <Space.Compact block>
          <Form.Item
            name="host"
            label={t('conn.proxyHost')}
            style={{ flex: 1 }}
            rules={[{ required: true, message: t('conn.proxyHostRequired') }]}
          >
            <Input placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item name="port" label={t('conn.port')} style={{ width: 110, marginLeft: 8 }}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="username" label={t('conn.proxyUsername')}>
          <Input autoComplete="off" placeholder={t('conn.proxyAuthOptional')} />
        </Form.Item>
        <Form.Item
          name="password"
          label={t('conn.proxyPassword')}
          extra={editing?.passwordRef ? t('conn.passwordSavedHint') : undefined}
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={editing?.passwordRef ? '••••••••' : ''}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

interface KeyProps {
  target: 'new' | SavedPrivateKey
  onClose: () => void
  onSaved?: (id: string) => void
}

interface KeyValues {
  name: string
  path: string
  passphrase?: string
  note?: string
}

export function PrivateKeyEditModal({ target, onClose, onSaved }: KeyProps): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm<KeyValues>()
  const saveKey = useSavedRefStore((s) => s.saveKey)
  const editing = target === 'new' ? undefined : target

  useEffect(() => {
    form.setFieldsValue({
      name: editing?.name ?? '',
      path: editing?.path ?? '',
      passphrase: '',
      note: editing?.note ?? ''
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  /** 选文件。选完顺手把名字填成文件名（用户没自己填过的话）—— 少一步打字 */
  const pick = async (): Promise<void> => {
    const path = await ofs.invoke('app:pickPath', {
      mode: 'openFile',
      title: t('conn.pickPrivateKey')
    })
    if (!path) return
    form.setFieldValue('path', path)
    if (!form.getFieldValue('name')) {
      form.setFieldValue('name', path.replace(/\\/g, '/').split('/').pop() ?? path)
    }
  }

  const submit = async (): Promise<void> => {
    const v = await form.validateFields()
    try {
      const saved = await saveKey({
        id: editing?.id,
        name: v.name.trim(),
        path: v.path.trim(),
        passphrase: v.passphrase || undefined,
        note: v.note || undefined
      })
      onSaved?.(saved.id)
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Modal
      open
      title={editing ? t('savedRef.keyEdit') : t('savedRef.keyNew')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="path"
          label={t('conn.privateKeyPath')}
          rules={[{ required: true, message: t('conn.privateKeyRequired') }]}
          extra={t('savedRef.keyPathHint')}
        >
          <Input
            placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
            addonAfter={<a onClick={() => void pick()}>{t('conn.browse')}</a>}
          />
        </Form.Item>
        <Form.Item
          name="name"
          label={t('savedRef.name')}
          rules={[{ required: true, message: t('savedRef.nameRequired') }]}
        >
          <Input placeholder={t('savedRef.keyNamePlaceholder')} />
        </Form.Item>
        <Form.Item
          name="passphrase"
          label={t('conn.passphrase')}
          extra={editing?.passphraseRef ? t('conn.passwordSavedHint') : t('savedRef.keyPassHint')}
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={editing?.passphraseRef ? '••••••••' : ''}
          />
        </Form.Item>
        <Form.Item name="note" label={t('conn.note')}>
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
