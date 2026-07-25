import { useEffect, useState } from 'react'
import { Checkbox, Input, Modal } from 'antd'
import { useTranslation } from 'react-i18next'

interface Props {
  open: boolean
  path: string
  mode: number
  onCancel: () => void
  onOk: (mode: number) => void
}

const CLASSES = ['owner', 'group', 'other'] as const
const BITS = [
  { key: 'r', value: 4 },
  { key: 'w', value: 2 },
  { key: 'x', value: 1 }
] as const

/** rwx 勾选 ↔ 八进制联动 */
export function PermissionModal({ open, path, mode, onCancel, onOk }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(mode & 0o777)
  const [octalText, setOctalText] = useState((mode & 0o777).toString(8).padStart(3, '0'))

  useEffect(() => {
    if (open) {
      const m = mode & 0o777
      setValue(m)
      setOctalText(m.toString(8).padStart(3, '0'))
    }
  }, [open, mode])

  const setBits = (next: number): void => {
    setValue(next)
    setOctalText(next.toString(8).padStart(3, '0'))
  }

  const digit = (classIndex: number): number => (value >> ((2 - classIndex) * 3)) & 0b111

  const toggle = (classIndex: number, bitValue: number): void => {
    const shift = (2 - classIndex) * 3
    const current = digit(classIndex)
    const nextDigit = current & bitValue ? current & ~bitValue : current | bitValue
    setBits((value & ~(0b111 << shift)) | (nextDigit << shift))
  }

  return (
    <Modal
      open={open}
      title={t('sftp.permissionTitle')}
      okText={t('common.ok')}
      cancelText={t('common.cancel')}
      onCancel={onCancel}
      onOk={() => onOk(value)}
      width={420}
    >
      <div style={{ marginBottom: 12, color: 'var(--ofs-text-2)', wordBreak: 'break-all' }}>{path}</div>
      <table style={{ width: '100%', marginBottom: 16 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', fontWeight: 500 }} />
            {BITS.map((b) => (
              <th key={b.key} style={{ fontWeight: 500 }}>
                {t(`sftp.perm_${b.key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CLASSES.map((cls, ci) => (
            <tr key={cls}>
              <td style={{ color: 'var(--ofs-text-2)' }}>{t(`sftp.perm_${cls}`)}</td>
              {BITS.map((b) => (
                <td key={b.key} style={{ textAlign: 'center' }}>
                  <Checkbox
                    checked={Boolean(digit(ci) & b.value)}
                    onChange={() => toggle(ci, b.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Input
        addonBefore={t('sftp.permOctal')}
        value={octalText}
        maxLength={4}
        onChange={(e) => {
          const text = e.target.value.replace(/[^0-7]/g, '')
          setOctalText(text)
          if (text) setValue(parseInt(text, 8) & 0o777)
        }}
      />
    </Modal>
  )
}
