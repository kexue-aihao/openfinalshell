import { useState } from 'react'
import {
  App as AntdApp,
  Alert,
  Button,
  Checkbox,
  Divider,
  Input,
  InputNumber,
  Menu,
  Modal,
  Radio,
  Segmented,
  Select,
  Slider,
  Switch,
  Typography
} from 'antd'
import { useTranslation } from 'react-i18next'
import { PRESET_COLORS, TERM_FONT_SIZE_MAX, TERM_FONT_SIZE_MIN } from '@shared/constants'
import { LOCALES } from '@shared/locales/registry'
import type { AppSettings } from '@shared/types'
import { ofs } from '@/ipc/api'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUiStore } from '@/stores/useUiStore'
import { terminalThemes } from '@/themes/terminal'
import { FinalShellImportPanel } from './FinalShellImportPanel'
import { ImportDataPanel } from './ImportDataPanel'
import { LanSyncPanel } from './LanSyncPanel'
import { KnownHostsPanel } from './KnownHostsPanel'
import { SavedRefsPanel } from './SavedRefsPanel'
import { DonateSection } from '@/features/donate/DonateSection'
import { ChangelogModal } from '@/features/onboarding/ChangelogModal'
import { UpdatePanel } from './UpdatePanel'
import { TerminalPreview } from './TerminalPreview'
import { SHORTCUTS } from './shortcuts'
import styles from './SettingsModal.module.css'

type Section =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'sftp'
  | 'savedRef'
  | 'security'
  | 'lanSync'
  | 'shortcuts'
  | 'about'

export function SettingsModal(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const open = useUiStore((s) => s.settingsOpen)
  const setOpen = useUiStore((s) => s.setSettingsOpen)
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsStore((s) => s.patch)
  const [section, setSection] = useState<Section>('general')
  const [vaultAvailable, setVaultAvailable] = useState<boolean | null>(null)
  const [versions, setVersions] = useState<Awaited<ReturnType<typeof loadVersions>> | null>(null)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [exportSecrets, setExportSecrets] = useState(false)
  const [exportEncryptAll, setExportEncryptAll] = useState(false)
  const [exportPass, setExportPass] = useState('')
  const [exporting, setExporting] = useState(false)

  async function loadVersions(): Promise<{
    app: string
    electron: string
    node: string
    chrome: string
  }> {
    return ofs.invoke('app:getVersions')
  }

  if (!settings) return <></>

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void =>
    patch({ [key]: value } as Partial<AppSettings>)
  const setTerminal = (v: Partial<AppSettings['terminal']>): void =>
    patch({ terminal: { ...settings.terminal, ...v } })
  const setSftp = (v: Partial<AppSettings['sftp']>): void => patch({ sftp: { ...settings.sftp, ...v } })

  const onOpenSection = (next: Section): void => {
    setSection(next)
    if (next === 'security' && vaultAvailable === null) {
      void ofs.invoke('vault:isAvailable').then(setVaultAvailable)
    }
    if (next === 'about' && !versions) {
      void loadVersions().then(setVersions)
    }
  }

  /** 导出：口令只单向进 main，成功后立刻从内存清掉 */
  const doExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const needPass = exportSecrets || exportEncryptAll
      const r = await ofs.invoke('app:exportData', {
        includeSecrets: exportSecrets,
        encryptAll: exportEncryptAll,
        passphrase: needPass ? exportPass : undefined
      })
      if (!r) return // 用户取消了保存对话框
      setExportPass('')
      message.success(
        t('settings.exportDone', { profiles: r.profiles, secrets: r.secrets, path: r.path })
      )
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  const pickDownloadDir = async (): Promise<void> => {
    const dir = await ofs.invoke('app:pickPath', {
      mode: 'openDirectory',
      title: t('settings.pickDownloadDir')
    })
    if (dir) setSftp({ downloadDir: dir })
  }

  return (
    <Modal
      open={open}
      className={styles.modal}
      title={t('activity.settings')}
      width={860}
      footer={null}
      onCancel={() => setOpen(false)}
      styles={{ body: { padding: 0, height: 560 } }}
    >
      <div className={styles.wrap}>
        <Menu
          mode="inline"
          className={styles.nav}
          selectedKeys={[section]}
          onSelect={({ key }) => onOpenSection(key as Section)}
          items={(
            [
              'general',
              'appearance',
              'terminal',
              'sftp',
              'savedRef',
              'security',
              'lanSync',
              'shortcuts',
              'about'
            ] as Section[]
          ).map((key) => ({
            key,
            // 代理与私钥那一段的标题住在 savedRef.* 里（整段文案都在那儿），
            // 不为了凑 settings.section_* 的命名再复制一份
            label: key === 'savedRef' ? t('savedRef.section') : t(`settings.section_${key}`)
          }))}
        />

        <div className={styles.content}>
          {section === 'general' && (
            <>
              <Row label={t('settings.language')}>
                <Select
                  value={settings.language}
                  style={{ width: 180 }}
                  onChange={(v) => set('language', v)}
                  options={LOCALES.map((l) => ({ value: l.tag, label: l.nativeName }))}
                />
              </Row>
              <Row label={t('settings.confirmOnCloseTab')} hint={t('settings.confirmOnCloseTabHint')}>
                <Switch
                  checked={settings.confirmOnCloseTab}
                  onChange={(v) => set('confirmOnCloseTab', v)}
                />
              </Row>
              <Row label={t('settings.autoCheckUpdate')} hint={t('settings.autoCheckUpdateHint')}>
                <Switch
                  checked={settings.autoCheckUpdate}
                  onChange={(v) => set('autoCheckUpdate', v)}
                />
              </Row>
              <Row label={t('settings.disableGpu')} hint={t('settings.disableGpuHint')}>
                <Switch
                  checked={settings.disableGpu}
                  onChange={(v) => {
                    set('disableGpu', v)
                    message.info(t('settings.restartRequired'))
                  }}
                />
              </Row>
            </>
          )}

          {section === 'appearance' && (
            <>
              <Row label={t('settings.theme')}>
                <Segmented
                  value={settings.themeMode}
                  onChange={(v) => set('themeMode', v as AppSettings['themeMode'])}
                  options={[
                    { label: t('settings.themeDark'), value: 'dark' },
                    { label: t('settings.themeLight'), value: 'light' },
                    { label: t('settings.themeSystem'), value: 'system' }
                  ]}
                />
              </Row>
              <Row label={t('settings.accent')}>
                <Radio.Group value={settings.accent} onChange={(e) => set('accent', e.target.value)}>
                  {PRESET_COLORS.map((c) => (
                    <Radio key={c} value={c}>
                      <span className={styles.colorDot} style={{ background: c }} />
                    </Radio>
                  ))}
                </Radio.Group>
              </Row>
              <Row label={t('settings.uiZoom')}>
                <div style={{ width: 240 }}>
                  <Slider
                    min={90}
                    max={150}
                    step={5}
                    value={settings.uiZoom}
                    marks={{ 100: '100%', 125: '125%', 150: '150%' }}
                    onChange={(v) => set('uiZoom', v)}
                  />
                </div>
              </Row>
              <Row
                label={t('settings.reduceTransparency')}
                hint={t('settings.reduceTransparencyHint')}
              >
                <Switch
                  checked={settings.reduceTransparency}
                  onChange={(v) => set('reduceTransparency', v)}
                />
              </Row>
              <Row label={t('settings.maskHostInList')} hint={t('settings.maskHostInListHint')}>
                <Switch
                  checked={settings.connection.maskHostInList}
                  onChange={(v) =>
                    patch({ connection: { ...settings.connection, maskHostInList: v } })
                  }
                />
              </Row>
            </>
          )}

          {section === 'terminal' && (
            <>
              <Row label={t('settings.fontFamily')}>
                <Input
                  style={{ width: 320 }}
                  value={settings.terminal.fontFamily}
                  onChange={(e) => setTerminal({ fontFamily: e.target.value })}
                />
              </Row>
              <Row label={t('settings.fontSize')}>
                <InputNumber
                  min={TERM_FONT_SIZE_MIN}
                  max={TERM_FONT_SIZE_MAX}
                  value={settings.terminal.fontSize}
                  onChange={(v) => v && setTerminal({ fontSize: v })}
                />
              </Row>
              <Row label={t('settings.lineHeight')}>
                <InputNumber
                  min={1}
                  max={2}
                  step={0.05}
                  value={settings.terminal.lineHeight}
                  onChange={(v) => v && setTerminal({ lineHeight: v })}
                />
              </Row>
              <Row label={t('settings.scrollback')} hint={t('settings.scrollbackHint')}>
                <InputNumber
                  min={1000}
                  max={100000}
                  step={1000}
                  value={settings.terminal.scrollback}
                  onChange={(v) => v && setTerminal({ scrollback: v })}
                />
              </Row>
              <Row label={t('settings.cursorStyle')}>
                <Segmented
                  value={settings.terminal.cursorStyle}
                  onChange={(v) => setTerminal({ cursorStyle: v as 'bar' | 'block' | 'underline' })}
                  options={[
                    { label: t('settings.cursorBar'), value: 'bar' },
                    { label: t('settings.cursorBlock'), value: 'block' },
                    { label: t('settings.cursorUnderline'), value: 'underline' }
                  ]}
                />
              </Row>
              <Row label={t('settings.cursorBlink')}>
                <Switch
                  checked={settings.terminal.cursorBlink}
                  onChange={(v) => setTerminal({ cursorBlink: v })}
                />
              </Row>
              <Divider style={{ margin: '8px 0' }} />
              <Row label={t('settings.terminalTheme')}>
                <Select
                  style={{ width: 200 }}
                  value={settings.terminal.themeId}
                  onChange={(v) => setTerminal({ themeId: v })}
                  options={[
                    { value: 'auto', label: t('settings.terminalThemeAuto') },
                    ...Object.entries(terminalThemes).map(([id, v]) => ({ value: id, label: v.name }))
                  ]}
                />
              </Row>
              <TerminalPreview themeId={settings.terminal.themeId} settings={settings} />
              <Divider style={{ margin: '8px 0' }} />
              <Row label={t('settings.copyOnSelect')}>
                <Switch
                  checked={settings.terminal.copyOnSelect}
                  onChange={(v) => setTerminal({ copyOnSelect: v })}
                />
              </Row>
              <Row label={t('settings.rightClick')}>
                <Segmented
                  value={settings.terminal.rightClick}
                  onChange={(v) => setTerminal({ rightClick: v as 'paste' | 'menu' })}
                  options={[
                    { label: t('settings.rightClickPaste'), value: 'paste' },
                    { label: t('settings.rightClickMenu'), value: 'menu' }
                  ]}
                />
              </Row>
              <Row label={t('settings.confirmMultilinePaste')}>
                <Switch
                  checked={settings.terminal.confirmMultilinePaste}
                  onChange={(v) => setTerminal({ confirmMultilinePaste: v })}
                />
              </Row>
              <Row label={t('settings.webgl')} hint={t('settings.webglHint')}>
                <Switch
                  checked={settings.terminal.webgl}
                  onChange={(v) => setTerminal({ webgl: v })}
                />
              </Row>
              <Row
                label={t('settings.saveCommandHistory')}
                hint={t('settings.saveCommandHistoryHint')}
              >
                <Switch
                  checked={settings.terminal.saveCommandHistory}
                  onChange={(v) => setTerminal({ saveCommandHistory: v })}
                />
              </Row>
            </>
          )}

          {section === 'sftp' && (
            <>
              <Row label={t('settings.downloadDir')} hint={t('settings.downloadDirHint')}>
                <Input
                  style={{ width: 380 }}
                  value={settings.sftp.downloadDir}
                  placeholder={t('settings.downloadDirPlaceholder')}
                  onChange={(e) => setSftp({ downloadDir: e.target.value })}
                  addonAfter={<a onClick={() => void pickDownloadDir()}>{t('conn.browse')}</a>}
                />
              </Row>
              <Row label={t('settings.maxConcurrentPerSession')}>
                <InputNumber
                  min={1}
                  max={8}
                  value={settings.sftp.maxConcurrentPerSession}
                  onChange={(v) => v && setSftp({ maxConcurrentPerSession: v })}
                />
              </Row>
              <Row label={t('settings.maxConcurrentGlobal')}>
                <InputNumber
                  min={1}
                  max={16}
                  value={settings.sftp.maxConcurrentGlobal}
                  onChange={(v) => v && setSftp({ maxConcurrentGlobal: v })}
                />
              </Row>
              {/*
                这个键在 DEFAULT_SETTINGS 里存在很久了，但**从来没有界面**
                （grep conflictPolicy 在渲染进程里一度零命中），也就一直不生效。
                现在它决定"上传撞名时要不要问、不问时怎么办"。
                'resume' 是历史遗留值，界面不给（选它等于 overwrite）。
              */}
              <Row label={t('settings.conflictPolicy')} hint={t('settings.conflictPolicyHint')}>
                <Select
                  value={settings.sftp.conflictPolicy === 'resume' ? 'overwrite' : settings.sftp.conflictPolicy}
                  style={{ width: 160 }}
                  onChange={(v) => setSftp({ conflictPolicy: v })}
                  options={[
                    { label: t('settings.conflictAsk'), value: 'ask' },
                    { label: t('settings.conflictOverwrite'), value: 'overwrite' },
                    { label: t('settings.conflictSkip'), value: 'skip' },
                    { label: t('settings.conflictRename'), value: 'rename' }
                  ]}
                />
              </Row>
              <Row label={t('settings.showHiddenFiles')}>
                <Switch
                  checked={settings.sftp.showHiddenFiles}
                  onChange={(v) => setSftp({ showHiddenFiles: v })}
                />
              </Row>
              <Row label={t('settings.followTerminalCd')} hint={t('settings.followTerminalCdHint')}>
                <Switch
                  checked={settings.sftp.followTerminalCd}
                  onChange={(v) => setSftp({ followTerminalCd: v })}
                />
              </Row>
              <Row label={t('settings.doubleClickAction')} hint={t('settings.doubleClickActionHint')}>
                <Segmented
                  value={settings.sftp.doubleClickAction}
                  onChange={(v) => setSftp({ doubleClickAction: v as 'download' | 'open' })}
                  options={[
                    { label: t('settings.doubleClickDownload'), value: 'download' },
                    { label: t('settings.doubleClickOpen'), value: 'open' }
                  ]}
                />
              </Row>
              <Row
                label={t('settings.autoOpenOnConnect')}
                hint={t('settings.autoOpenOnConnectHint')}
              >
                <Switch
                  checked={settings.sftp.autoOpenOnConnect}
                  onChange={(v) => setSftp({ autoOpenOnConnect: v })}
                />
              </Row>
              <Row label={t('settings.fastDelete')} hint={t('settings.fastDeleteHint')}>
                <Switch
                  checked={settings.sftp.fastDelete}
                  onChange={(v) => setSftp({ fastDelete: v })}
                />
              </Row>
              <Row label={t('settings.packedTransfer')} hint={t('settings.packedTransferHint')}>
                <Switch
                  checked={settings.sftp.packedTransfer}
                  onChange={(v) => setSftp({ packedTransfer: v })}
                />
              </Row>
              <Row label={t('settings.monitorInterval')}>
                <InputNumber
                  min={1000}
                  max={10000}
                  step={500}
                  addonAfter="ms"
                  value={settings.monitor.intervalMs}
                  onChange={(v) => v && patch({ monitor: { intervalMs: v } })}
                />
              </Row>
            </>
          )}

          {section === 'savedRef' && <SavedRefsPanel />}

          {section === 'security' && (
            <>
              {vaultAvailable === false && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message={t('settings.vaultUnavailable')}
                  description={t('settings.vaultUnavailableDesc')}
                />
              )}
              {vaultAvailable === true && (
                <Alert
                  type="success"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message={t('settings.vaultAvailable')}
                  description={t('settings.vaultAvailableDesc')}
                />
              )}
              <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                {t('settings.securityNotes')}
              </Typography.Paragraph>

              <Typography.Title level={5} style={{ marginTop: 24 }}>
                {t('settings.exportTitle')}
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                {t('settings.exportDesc')}
              </Typography.Paragraph>
              <Checkbox
                checked={exportSecrets}
                onChange={(e) => setExportSecrets(e.target.checked)}
                style={{ marginBottom: 8 }}
              >
                {t('settings.exportIncludeSecrets')}
              </Checkbox>
              <br />
              <Checkbox
                checked={exportEncryptAll}
                onChange={(e) => setExportEncryptAll(e.target.checked)}
                style={{ marginBottom: 8 }}
              >
                {t('settings.exportEncryptAll')}
              </Checkbox>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                {t('settings.exportEncryptAllHint')}
              </Typography.Paragraph>
              {(exportSecrets || exportEncryptAll) && (
                <Input.Password
                  value={exportPass}
                  onChange={(e) => setExportPass(e.target.value)}
                  placeholder={t('settings.exportPassphrasePlaceholder')}
                  style={{ marginBottom: 8 }}
                  autoComplete="new-password"
                />
              )}
              <div>
                <Button loading={exporting} onClick={() => void doExport()}>
                  {t('settings.exportButton')}
                </Button>
              </div>

              <ImportDataPanel />
              <FinalShellImportPanel />
              <KnownHostsPanel />
            </>
          )}

          {section === 'lanSync' && <LanSyncPanel />}

          {section === 'shortcuts' && (
            <table className={styles.shortcutTable}>
              <tbody>
                {SHORTCUTS.map((s) => (
                  <tr key={s.keys}>
                    <td>
                      <kbd className={styles.kbd}>{s.keys}</kbd>
                    </td>
                    <td>{t(s.descKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {section === 'about' && (
            <div className={styles.about}>
              <div className={styles.aboutLogo} />
              <div className={styles.aboutName}>OpenFinalShell</div>
              <div className={styles.aboutVersion}>
                {versions
                  ? `v${versions.app} · Electron ${versions.electron} · Node ${versions.node} · Chromium ${versions.chrome}`
                  : '…'}
              </div>
              <Typography.Paragraph type="secondary" style={{ marginTop: 12, textAlign: 'center' }}>
                {t('welcome.subtitle')}
              </Typography.Paragraph>
              <UpdatePanel />
              <div>
                <Button type="link" onClick={() => setChangelogOpen(true)}>
                  {t('settings.changelog')}
                </Button>
                <Button
                  type="link"
                  onClick={() =>
                    void ofs
                      .invoke('app:openExternal', 'https://github.com/openfinalshell/openfinalshell')
                      .catch(() => message.error(t('settings.openLinkFailed')))
                  }
                >
                  GitHub
                </Button>
              </div>
              <div className={styles.aboutLicense}>MIT License</div>
              <DonateSection />
              <ChangelogModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}>
        <div>{label}</div>
        {hint && <div className={styles.rowHint}>{hint}</div>}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}
