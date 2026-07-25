import { useEffect } from 'react'
import { Form, Input, InputNumber, Modal, Segmented, Switch } from 'antd'
import { useTranslation } from 'react-i18next'
import type { ForwardRule, ForwardType, ProfileId } from '@shared/types'

interface Props {
  open: boolean
  profileId: ProfileId
  rule: ForwardRule | null
  onCancel: () => void
  onOk: (rule: ForwardRule) => void
}

interface FormValues {
  type: ForwardType
  label: string
  bindAddr: string
  bindPort: number
  dstHost?: string
  dstPort?: number
  autoStart: boolean
}

export function ForwardRuleModal({ open, profileId, rule, onCancel, onOk }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [form] = Form.useForm<FormValues>()

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({
      type: rule?.type ?? 'local',
      label: rule?.label ?? '',
      bindAddr: rule?.bindAddr ?? '127.0.0.1',
      bindPort: rule?.bindPort ?? 8080,
      dstHost: rule?.dstHost ?? '127.0.0.1',
      dstPort: rule?.dstPort ?? 3306,
      autoStart: rule?.autoStart ?? false
    })
  }, [open, rule, form])

  const submit = async (): Promise<void> => {
    const v = await form.validateFields()
    onOk({
      id: rule?.id ?? crypto.randomUUID(),
      profileId,
      type: v.type,
      label: v.label.trim() || t('forward.untitled'),
      bindAddr: v.bindAddr.trim() || '127.0.0.1',
      bindPort: v.bindPort,
      dstHost: v.type === 'dynamic' ? undefined : v.dstHost?.trim(),
      dstPort: v.type === 'dynamic' ? undefined : v.dstPort,
      autoStart: v.autoStart
    })
  }

  return (
    <Modal
      open={open}
      title={rule ? t('forward.editTitle') : t('forward.newTitle')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      onOk={() => void submit()}
      onCancel={onCancel}
      destroyOnHidden
      width={460}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="type" label={t('forward.type')}>
          <Segmented
            block
            options={[
              { label: t('forward.typeLocal'), value: 'local' },
              { label: t('forward.typeRemote'), value: 'remote' },
              { label: t('forward.typeDynamic'), value: 'dynamic' }
            ]}
          />
        </Form.Item>

        <Form.Item noStyle shouldUpdate={(a, b) => a.type !== b.type}>
          {({ getFieldValue }) => (
            <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--ofs-text-3)' }}>
              {t(`forward.hint_${getFieldValue('type') as ForwardType}`)}
            </div>
          )}
        </Form.Item>

        <Form.Item name="label" label={t('forward.label')}>
          <Input placeholder={t('forward.labelPlaceholder')} />
        </Form.Item>

        <div style={{ display: 'flex', gap: 8 }}>
          <Form.Item name="bindAddr" label={t('forward.bindAddr')} style={{ flex: 1 }}>
            <Input placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item
            name="bindPort"
            label={t('forward.bindPort')}
            style={{ width: 120 }}
            rules={[{ required: true, message: t('forward.portRequired') }]}
          >
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
        </div>

        <Form.Item noStyle shouldUpdate={(a, b) => a.type !== b.type}>
          {({ getFieldValue }) =>
            getFieldValue('type') === 'dynamic' ? null : (
              <div style={{ display: 'flex', gap: 8 }}>
                <Form.Item
                  name="dstHost"
                  label={t('forward.dstHost')}
                  style={{ flex: 1 }}
                  rules={[{ required: true, message: t('forward.dstRequired') }]}
                >
                  <Input placeholder="127.0.0.1 / db.internal" />
                </Form.Item>
                <Form.Item
                  name="dstPort"
                  label={t('forward.dstPort')}
                  style={{ width: 120 }}
                  rules={[{ required: true, message: t('forward.portRequired') }]}
                >
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
              </div>
            )
          }
        </Form.Item>

        <Form.Item name="autoStart" label={t('forward.autoStart')} valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  )
}
