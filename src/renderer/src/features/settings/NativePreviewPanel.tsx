import { useEffect, useState } from 'react'
import { Alert, App as AntdApp, Button, Card, Input, Modal, Progress, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, FileLock2, Info } from 'lucide-react'
import { ofs } from '@/ipc/api'

type UpgradeInfo = Awaited<ReturnType<typeof getUpgradeInfo>>
type UpgradeAction = 'export' | 'download'
type AppVersions = Awaited<ReturnType<typeof getAppVersions>>

async function getUpgradeInfo(): Promise<{
  architecture: 'x64' | 'x86' | 'arm64'
  availableVersion?: string
  installed: boolean
  installedVersion?: string
  manifestError?: string
}> {
  return ofs.invoke('nativePreview:getInfo')
}

async function getAppVersions(): Promise<{ app: string; electron: string; node: string; chrome: string }> {
  return ofs.invoke('app:getVersions')
}

export function NativePreviewPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const [info, setInfo] = useState<UpgradeInfo | null>(null)
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [percent, setPercent] = useState(0)
  const [downloaded, setDownloaded] = useState(false)
  const [installerStarted, setInstallerStarted] = useState(false)
  const [error, setError] = useState('')
  const [helpOpen, setHelpOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<UpgradeAction | null>(null)
  const [installConfirmOpen, setInstallConfirmOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [passphraseAgain, setPassphraseAgain] = useState('')

  const loadInfo = async (): Promise<void> => {
    setChecking(true)
    setError('')
    try { setInfo(await getUpgradeInfo()) }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setChecking(false) }
  }

  useEffect(() => {
    void Promise.all([loadInfo(), getAppVersions().then(setVersions).catch(() => {})])
    const dispose = ofs.on('nativePreview:progress', (event) => {
      setBusy(true)
      setPercent(event.percent)
    })
    return dispose
  }, [])

  const confirmed = (): boolean => {
    try { return localStorage.getItem('ofs-native-preview-migration-confirmed-v1') === 'yes' }
    catch { return false }
  }

  const requestAction = (action: UpgradeAction): void => {
    if (confirmed()) {
      if (action === 'export') setExportOpen(true)
      else void download()
      return
    }
    setConfirmAction(action)
  }

  const confirmMigration = (): void => {
    try { localStorage.setItem('ofs-native-preview-migration-confirmed-v1', 'yes') } catch { /* session confirmation still applies */ }
    const action = confirmAction
    setConfirmAction(null)
    if (action === 'export') setExportOpen(true)
    else if (action === 'download') void download()
  }

  const download = async (): Promise<void> => {
    setBusy(true)
    setPercent(0)
    setDownloaded(false)
    setError('')
    try {
      await ofs.invoke('nativePreview:download')
      setDownloaded(true)
      setPercent(100)
      message.success(t('nativePreview.downloaded'))
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught)
      setError(text)
      message.error(text)
    } finally { setBusy(false) }
  }

  const exportEncrypted = async (): Promise<void> => {
    if (passphrase.length < 8) { message.error(t('nativePreview.passphraseShort')); return }
    if (passphrase !== passphraseAgain) { message.error(t('nativePreview.passphraseMismatch')); return }
    setBusy(true)
    try {
      const result = await ofs.invoke('app:exportData', { includeSecrets: true, encryptAll: true, passphrase })
      if (result) message.success(t('nativePreview.exported', { count: result.profiles }))
      setPassphrase('')
      setPassphraseAgain('')
      setExportOpen(false)
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught)
      setError(text)
      message.error(text)
    } finally { setBusy(false) }
  }

  const install = async (): Promise<void> => {
    setBusy(true)
    try {
      await ofs.invoke('nativePreview:launchInstaller')
      setInstallerStarted(true)
      setInstallConfirmOpen(false)
      message.info(t('nativePreview.installerStarted'))
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught)
      setError(text)
      message.error(text)
    } finally { setBusy(false) }
  }

  const openNative = async (): Promise<void> => {
    try { await ofs.invoke('nativePreview:openInstalled') }
    catch (caught) { message.error(caught instanceof Error ? caught.message : String(caught)) }
  }

  return (
    <>
      <Card
        size="small"
        title={t('nativePreview.title')}
        style={{ marginTop: 16, width: '100%', maxWidth: 560, textAlign: 'left' }}
        extra={info ? <Tag color={info.installed ? 'green' : 'default'}>{info.installed ? t('nativePreview.installed') : t('nativePreview.notInstalled')}</Tag> : null}
      >
        <Typography.Paragraph type="secondary">{t('nativePreview.description')}</Typography.Paragraph>
        {info ? (
          <Typography.Paragraph type="secondary">
            {versions ? t('nativePreview.currentVersion', { version: versions.app }) + ' · ' : ''}
            {info.availableVersion
              ? t('nativePreview.versionArchitecture', { version: info.availableVersion, architecture: info.architecture })
              : t('nativePreview.architectureOnly', { architecture: info.architecture })}
            {info.installedVersion ? ` · ${t('nativePreview.installedVersion', { version: info.installedVersion })}` : ''}
          </Typography.Paragraph>
        ) : checking ? <Typography.Text type="secondary">{t('nativePreview.checking')}</Typography.Text> : null}
        {info?.manifestError && <Alert type="warning" showIcon message={t('nativePreview.feedUnavailable')} description={info.manifestError} style={{ marginBottom: 12 }} />}
        <Alert
          showIcon
          type="info"
          icon={<Info size={16} />}
          message={t('nativePreview.dataNote')}
          style={{ marginBottom: 12 }}
        />
        {busy && <Progress percent={percent} status="active" size="small" />}
        {error && <Alert type="error" showIcon message={t('nativePreview.downloadError')} description={error} style={{ marginBottom: 12 }} />}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button icon={<FileLock2 size={14} />} onClick={() => requestAction('export')} disabled={busy}>
            {t('nativePreview.exportButton')}
          </Button>
          <Button type="primary" icon={<Download size={14} />} loading={busy && !exportOpen} onClick={() => requestAction('download')}>
            {downloaded ? t('nativePreview.downloadAgain') : t('nativePreview.downloadButton')}
          </Button>
          {downloaded && <Button onClick={() => setInstallConfirmOpen(true)}>{t('nativePreview.installButton')}</Button>}
          {(installerStarted || info?.installed) && <Button icon={<ExternalLink size={14} />} onClick={() => void openNative()}>{t('nativePreview.openButton')}</Button>}
          <Button type="link" onClick={() => setHelpOpen(true)}>{t('nativePreview.instructionsButton')}</Button>
        </div>
      </Card>

      <Modal open={confirmAction !== null} title={t('nativePreview.confirmTitle')} okText={t('nativePreview.confirmOk')} cancelText={t('common.cancel')} onOk={confirmMigration} onCancel={() => setConfirmAction(null)}>
        <Typography.Paragraph>{t('nativePreview.confirmBody')}</Typography.Paragraph>
        <Typography.Paragraph>{t('nativePreview.privacyNote')}</Typography.Paragraph>
      </Modal>

      <Modal open={exportOpen} title={t('nativePreview.exportTitle')} okText={t('nativePreview.exportButton')} cancelText={t('common.cancel')} confirmLoading={busy} onOk={() => void exportEncrypted()} onCancel={() => { setExportOpen(false); setPassphrase(''); setPassphraseAgain('') }}>
        <Typography.Paragraph>{t('nativePreview.exportBody')}</Typography.Paragraph>
        <Input.Password autoComplete="new-password" value={passphrase} placeholder={t('nativePreview.passphrase')} onChange={(event) => setPassphrase(event.target.value)} style={{ marginBottom: 8 }} />
        <Input.Password autoComplete="new-password" value={passphraseAgain} placeholder={t('nativePreview.passphraseAgain')} onChange={(event) => setPassphraseAgain(event.target.value)} />
      </Modal>

      <Modal open={installConfirmOpen} title={t('nativePreview.installTitle')} okText={t('nativePreview.installButton')} cancelText={t('common.cancel')} confirmLoading={busy} onOk={() => void install()} onCancel={() => setInstallConfirmOpen(false)}>
        <Typography.Paragraph>{t('nativePreview.installBody')}</Typography.Paragraph>
        <Typography.Paragraph type="secondary">{t('nativePreview.dataNote')}</Typography.Paragraph>
      </Modal>

      <Modal open={helpOpen} title={t('nativePreview.instructionsTitle')} footer={null} onCancel={() => setHelpOpen(false)}>
        <Typography.Paragraph>{t('nativePreview.instructionsBody')}</Typography.Paragraph>
        <Typography.Paragraph code copyable>%LOCALAPPDATA%\OpenFinalShell.NativePreview</Typography.Paragraph>
        <Typography.Paragraph>{t('nativePreview.privacyNote')}</Typography.Paragraph>
      </Modal>
    </>
  )
}
