import { useState } from 'react'
import { App as AntdApp, Alert, Button, Checkbox, Input, Modal, Radio, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type {
  ImportConflictPolicy,
  ImportPreview,
  ImportResult,
  ImportSelection
} from '@shared/types'
import { ofs } from '@/ipc/api'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useForwardStore } from '@/stores/useForwardStore'
import { useSnippetStore } from '@/stores/useSnippetStore'
import styles from './SettingsModal.module.css'

/**
 * 导入应用数据。两步走：先选文件拿概要（main 侧解析并暂存，这里只持有 token），
 * 用户确认要导入哪些部分、同名怎么处理之后再真正写入。
 */
export function ImportDataPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const loadConnections = useConnectionStore((s) => s.load)
  const loadSnippets = useSnippetStore((s) => s.load)
  const loadForwards = useForwardStore((s) => s.load)

  const [picking, setPicking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [pass, setPass] = useState('')
  const [conflict, setConflict] = useState<ImportConflictPolicy>('skip')
  // 设置默认不勾：它是唯一会立刻改变界面外观的部分，别人的配色不该悄悄套到本机上
  const [include, setInclude] = useState<ImportSelection>({
    profiles: true,
    snippets: true,
    forwards: true,
    knownHosts: true,
    settings: false
  })

  const pick = async (): Promise<void> => {
    setPicking(true)
    try {
      const p = await ofs.invoke('app:importPreview')
      if (!p) return // 用户取消了文件对话框
      setPass('')
      setResult(null)
      setPreview(p)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setPicking(false)
    }
  }

  const run = async (): Promise<void> => {
    if (!preview) return
    setImporting(true)
    try {
      const r = await ofs.invoke('app:importData', {
        token: preview.token,
        passphrase: preview.includesSecrets && pass ? pass : undefined,
        conflict,
        include
      })
      setPass('')
      setResult(r)
      await Promise.all([loadConnections(), loadSnippets(), loadForwards()])
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  const close = (): void => {
    setPreview(null)
    setResult(null)
    setPass('')
  }

  const toggle = (key: keyof ImportSelection) => (checked: boolean): void =>
    setInclude((s) => ({ ...s, [key]: checked }))

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        {t('settings.importTitle')}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t('settings.importDesc')}
      </Typography.Paragraph>
      <div>
        <Button loading={picking} onClick={() => void pick()}>
          {t('settings.importButton')}
        </Button>
      </div>

      <Modal
        open={preview !== null}
        title={result ? t('settings.importResultTitle') : t('settings.importModalTitle')}
        width={560}
        maskClosable={false}
        onCancel={close}
        footer={
          result ? (
            <Button type="primary" onClick={close}>
              {t('settings.importClose')}
            </Button>
          ) : (
            <>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button type="primary" loading={importing} onClick={() => void run()}>
                {t('settings.importConfirm')}
              </Button>
            </>
          )
        }
      >
        {preview && !result && (
          <>
            <div className={styles.importInfo}>
              <div>{preview.path}</div>
              <div>
                {t('settings.importMeta', {
                  version: preview.appVersion,
                  time:
                    preview.exportedAt > 0
                      ? new Date(preview.exportedAt).toLocaleString()
                      : '—'
                })}
              </div>
            </div>

            {preview.invalid > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={t('settings.importInvalidWarn', { count: preview.invalid })}
              />
            )}
            {preview.conflicts > 0 && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message={t('settings.importConflictWarn', { count: preview.conflicts })}
              />
            )}

            <div className={styles.importSection}>{t('settings.importSelectLabel')}</div>
            <div className={styles.importChecks}>
              <Checkbox
                checked={include.profiles}
                onChange={(e) => toggle('profiles')(e.target.checked)}
              >
                {t('settings.importIncludeProfiles', {
                  profiles: preview.counts.profiles,
                  groups: preview.counts.groups
                })}
              </Checkbox>
              <Checkbox
                checked={include.snippets}
                onChange={(e) => toggle('snippets')(e.target.checked)}
              >
                {t('settings.importIncludeSnippets', { count: preview.counts.snippets })}
              </Checkbox>
              <Checkbox
                checked={include.forwards}
                onChange={(e) => toggle('forwards')(e.target.checked)}
              >
                {t('settings.importIncludeForwards', { count: preview.counts.forwards })}
              </Checkbox>
              <Checkbox
                checked={include.knownHosts}
                onChange={(e) => toggle('knownHosts')(e.target.checked)}
              >
                {t('settings.importIncludeKnownHosts', { count: preview.counts.knownHosts })}
              </Checkbox>
              <Checkbox
                checked={include.settings}
                disabled={!preview.counts.settings}
                onChange={(e) => toggle('settings')(e.target.checked)}
              >
                {t('settings.importIncludeSettings')}
              </Checkbox>
            </div>

            {preview.includesSecrets ? (
              <>
                <div className={styles.importSection}>{t('settings.importPassphraseLabel')}</div>
                <Input.Password
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder={t('settings.importPassphrasePlaceholder')}
                  autoComplete="new-password"
                />
              </>
            ) : (
              <div className={styles.importHint}>{t('settings.importNoSecrets')}</div>
            )}

            <div className={styles.importSection}>{t('settings.importConflictLabel')}</div>
            <Radio.Group
              value={conflict}
              onChange={(e) => setConflict(e.target.value as ImportConflictPolicy)}
            >
              <Radio value="skip">{t('settings.importConflictSkip')}</Radio>
              <Radio value="overwrite">{t('settings.importConflictOverwrite')}</Radio>
              <Radio value="duplicate">{t('settings.importConflictDuplicate')}</Radio>
            </Radio.Group>
            <div className={styles.importHint}>
              {conflict === 'skip' && t('settings.importConflictSkipHint')}
              {conflict === 'overwrite' && t('settings.importConflictOverwriteHint')}
              {conflict === 'duplicate' && t('settings.importConflictDuplicateHint')}
            </div>
          </>
        )}

        {result && (
          <>
            <Alert
              type="success"
              showIcon
              message={t('settings.importResultSummary', {
                profiles: result.profiles,
                snippets: result.snippets,
                forwards: result.forwards,
                knownHosts: result.knownHosts,
                secrets: result.secrets
              })}
              description={t('settings.importResultSkipped', {
                skipped: result.skipped,
                invalid: result.invalid
              })}
            />
            {result.notes.length > 0 && (
              <ul className={styles.importNotes}>
                {result.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Modal>
    </>
  )
}
