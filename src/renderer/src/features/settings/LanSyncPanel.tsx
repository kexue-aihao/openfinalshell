import { useEffect, useState } from 'react'
import { App as AntdApp, Alert, Button, Checkbox, Input, Modal, Radio, Space, Spin, Typography } from 'antd'
import { RefreshCw, Send, Wifi } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ImportConflictPolicy, ImportSelection, LanSyncDevice } from '@shared/types'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useForwardStore } from '@/stores/useForwardStore'
import { useSnippetStore } from '@/stores/useSnippetStore'
import { useLanSyncStore } from '@/stores/useLanSyncStore'
import styles from './SettingsModal.module.css'
import lan from './LanSyncPanel.module.css'

/**
 * 局域网同步（手动收发）。左卡「接收」亮配对码等人发；右卡「发送」扫描/手输目标 + 输码发。
 * 收到数据时弹一个确认框——结构镜像文件导入（同一套冲突策略/内容勾选/结果摘要文案），
 * 用户已有的心智直接复用。
 *
 * 一切网络与配对都在 main（LanSyncManager）；这里只发 invoke、显示 main 推来的状态。
 */
export function LanSyncPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const receive = useLanSyncStore((s) => s.receive)
  const send = useLanSyncStore((s) => s.send)
  const devices = useLanSyncStore((s) => s.devices)
  const scanning = useLanSyncStore((s) => s.scanning)
  const store = useLanSyncStore

  const loadConnections = useConnectionStore((s) => s.load)
  const loadSnippets = useSnippetStore((s) => s.load)
  const loadForwards = useForwardStore((s) => s.load)

  const [manual, setManual] = useState('')
  const [code, setCode] = useState('')
  const [includeSecrets, setIncludeSecrets] = useState(true)
  const [target, setTarget] = useState<{ host: string; port: number } | null>(null)
  // 接收确认框的选择（与文件导入同默认：settings 不勾）
  const [conflict, setConflict] = useState<ImportConflictPolicy>('skip')
  const [include, setInclude] = useState<ImportSelection>({
    profiles: true,
    snippets: true,
    forwards: true,
    knownHosts: true,
    settings: false
  })

  // 面板挂载时对齐一次现状——事件可能在挂载前就到过（接收态是常驻的）
  useEffect(() => {
    void store.getState().refreshReceive()
  }, [store])

  const wrap = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const doSend = (dev: LanSyncDevice | null): void => {
    const tgt = dev ? { host: dev.address, port: dev.tcpPort } : parseManual(manual)
    if (!tgt) {
      message.warning(t('sync.invalidTarget'))
      return
    }
    if (!/^\d{6}$/.test(code)) {
      message.warning(t('sync.codeRequired'))
      return
    }
    setTarget(tgt)
    // 发送错误不走 message.error：失败会经 sync:sendState 推回 phase:'error'，由下方常驻
    // Alert 承担唯一展示（否则同一句错误既弹 toast 又留 Alert，重复且与文件导入面板不一致）。
    // 这里只吞掉 Promise 拒绝，避免 unhandledRejection
    void store.getState().sendTo(tgt, code, includeSecrets).catch(() => {})
  }

  const applyIncoming = async (): Promise<void> => {
    const preview = receive.preview
    if (!preview) return
    await wrap(async () => {
      await store.getState().apply({ token: preview.token, conflict, include })
      await Promise.all([loadConnections(), loadSnippets(), loadForwards()])
    })
  }

  const toggle = (key: keyof ImportSelection) => (checked: boolean): void =>
    setInclude((s) => ({ ...s, [key]: checked }))

  const receiving = receive.phase !== 'idle'
  const sendBusy = send.phase === 'connecting' || send.phase === 'confirming' || send.phase === 'sending'

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        {t('sync.title')}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t('sync.desc')}
      </Typography.Paragraph>

      <div className={lan.cards}>
        {/* ---- 接收 ---- */}
        <div className={lan.card}>
          <div className={lan.cardTitle}>{t('sync.receiveTitle')}</div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {t('sync.receiveDesc')}
          </Typography.Paragraph>

          {!receiving && (
            <Button type="primary" onClick={() => void wrap(() => store.getState().startReceive())}>
              {t('sync.receiveStart')}
            </Button>
          )}

          {receiving && (
            <>
              {receive.code && (
                <div className={lan.codeBox}>
                  <div className={lan.codeLabel}>{t('sync.codeLabel')}</div>
                  <div className={lan.code}>{receive.code}</div>
                </div>
              )}
              {(receive.phase === 'waiting' || receive.phase === 'handshake') && (
                <div className={lan.waiting}>
                  <Spin size="small" /> <span>{t('sync.waitingHint')}</span>
                </div>
              )}
              {receive.phase === 'receiving' && (
                <div className={lan.waiting}>
                  <Spin size="small" /> <span>{t('sync.receivingHint', { name: receive.from?.deviceName ?? '' })}</span>
                </div>
              )}
              {receive.tcpPort != null && receive.addresses && receive.addresses.length > 0 && (
                <div className={lan.addrBlock}>
                  <div className={lan.subLabel}>{t('sync.addressLabel')}</div>
                  {receive.addresses.map((a) => (
                    <div key={a} className={lan.addr}>
                      {a}:{receive.tcpPort}
                    </div>
                  ))}
                </div>
              )}
              {receive.phase === 'done' && receive.result && (
                <Alert
                  type="success"
                  showIcon
                  style={{ marginTop: 8 }}
                  message={t('settings.importResultSummary', {
                    profiles: receive.result.profiles,
                    snippets: receive.result.snippets,
                    forwards: receive.result.forwards,
                    knownHosts: receive.result.knownHosts,
                    secrets: receive.result.secrets
                  })}
                />
              )}
              <Alert type="info" showIcon style={{ marginTop: 8 }} message={t('sync.firewallHint')} />
              <Button style={{ marginTop: 8 }} onClick={() => void wrap(() => store.getState().stopReceive())}>
                {t('sync.receiveStop')}
              </Button>
            </>
          )}
        </div>

        {/* ---- 发送 ---- */}
        <div className={lan.card}>
          <div className={lan.cardTitle}>{t('sync.sendTitle')}</div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {t('sync.sendDesc')}
          </Typography.Paragraph>

          <Space>
            <Button
              icon={<RefreshCw size={14} strokeWidth={1.75} />}
              loading={scanning}
              onClick={() => void wrap(() => store.getState().scan())}
            >
              {scanning ? t('sync.scanning') : t('sync.scan')}
            </Button>
          </Space>

          <div className={lan.devices}>
            {!scanning && devices.length === 0 && (
              <div className={lan.noDevices}>{t('sync.noDevices')}</div>
            )}
            {devices.map((d) => (
              <div key={`${d.deviceId}@${d.address}`} className={lan.device}>
                <Wifi size={14} strokeWidth={1.75} />
                <div className={lan.deviceMain}>
                  <div className={lan.deviceName}>{d.deviceName || d.address}</div>
                  <div className={lan.deviceAddr}>
                    {d.address}:{d.tcpPort} · v{d.appVersion}
                  </div>
                </div>
                <Button size="small" type="primary" disabled={sendBusy} onClick={() => doSend(d)}>
                  {t('sync.sendButton')}
                </Button>
              </div>
            ))}
          </div>

          <div className={lan.subLabel} style={{ marginTop: 8 }}>
            {t('sync.manualLabel')}
          </div>
          <Input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder={t('sync.manualPlaceholder')}
          />

          <div className={lan.subLabel} style={{ marginTop: 8 }}>
            {t('sync.codeInputLabel')}
          </div>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder={t('sync.codePlaceholder')}
            inputMode="numeric"
            maxLength={6}
          />

          <Checkbox
            style={{ marginTop: 8 }}
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
          >
            {t('sync.includeSecrets')}
          </Checkbox>

          <div style={{ marginTop: 8 }}>
            {sendBusy ? (
              <Button danger onClick={() => void wrap(() => store.getState().cancelSend())}>
                {t('sync.cancel')}
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<Send size={14} strokeWidth={1.75} />}
                onClick={() => doSend(null)}
              >
                {t('sync.sendButton')}
              </Button>
            )}
          </div>

          {send.phase !== 'idle' && (
            <div className={lan.sendStatus}>
              {sendBusy && <Spin size="small" />}
              <span>{sendStatusText(send.phase, t, send.peer?.deviceName ?? target?.host ?? '')}</span>
            </div>
          )}
          {send.phase === 'applied' && send.remoteResult && (
            <Alert
              type="success"
              showIcon
              style={{ marginTop: 8 }}
              message={t('sync.appliedSummary', {
                profiles: send.remoteResult.profiles,
                secrets: send.remoteResult.secrets,
                skipped: send.remoteResult.skipped
              })}
            />
          )}
          {send.phase === 'rejected' && (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t('sync.rejectedByPeer')} />
          )}
          {send.phase === 'error' && send.error && (
            <Alert type="error" showIcon style={{ marginTop: 8 }} message={send.error} />
          )}
        </div>
      </div>

      {/* ---- 收到数据的确认框（镜像文件导入的单弹窗结构） ---- */}
      <Modal
        open={receive.phase === 'incoming' && !!receive.preview}
        title={t('sync.incomingTitle')}
        okText={t('sync.applyButton')}
        cancelText={t('sync.rejectButton')}
        onOk={() => void applyIncoming()}
        onCancel={() => {
          if (receive.preview) void wrap(() => store.getState().dismiss(receive.preview!.token))
        }}
        maskClosable={false}
      >
        {receive.preview && (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={t('sync.incomingFrom', {
                name: receive.from?.deviceName || receive.from?.address || '',
                address: receive.from?.address ?? ''
              })}
            />
            <div className={styles.importChecks}>
              <Checkbox checked={include.profiles} onChange={(e) => toggle('profiles')(e.target.checked)}>
                {t('settings.importIncludeProfiles', {
                  profiles: receive.preview.counts.profiles,
                  groups: receive.preview.counts.groups
                })}
              </Checkbox>
              <Checkbox checked={include.snippets} onChange={(e) => toggle('snippets')(e.target.checked)}>
                {t('settings.importIncludeSnippets', { count: receive.preview.counts.snippets })}
              </Checkbox>
              <Checkbox checked={include.forwards} onChange={(e) => toggle('forwards')(e.target.checked)}>
                {t('settings.importIncludeForwards', { count: receive.preview.counts.forwards })}
              </Checkbox>
              <Checkbox checked={include.knownHosts} onChange={(e) => toggle('knownHosts')(e.target.checked)}>
                {t('settings.importIncludeKnownHosts', { count: receive.preview.counts.knownHosts })}
              </Checkbox>
              <Checkbox
                checked={include.settings}
                disabled={!receive.preview.counts.settings}
                onChange={(e) => toggle('settings')(e.target.checked)}
              >
                {t('settings.importIncludeSettings')}
              </Checkbox>
            </div>

            <div className={styles.importSection}>{t('settings.importConflictLabel')}</div>
            <Radio.Group value={conflict} onChange={(e) => setConflict(e.target.value as ImportConflictPolicy)}>
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
      </Modal>
    </>
  )
}

/** 解析「IP:端口」；端口缺失/越界返回 null */
function parseManual(raw: string): { host: string; port: number } | null {
  const s = raw.trim()
  const idx = s.lastIndexOf(':')
  if (idx <= 0) return null
  const host = s.slice(0, idx).trim()
  const port = Number(s.slice(idx + 1).trim())
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

type TFn = (key: string, vars?: Record<string, unknown>) => string
function sendStatusText(phase: string, t: TFn, name: string): string {
  switch (phase) {
    case 'connecting':
      return t('sync.statusConnecting')
    case 'confirming':
      return t('sync.statusConfirming')
    case 'sending':
      return t('sync.statusSending')
    case 'delivered':
      return t('sync.statusDelivered', { name })
    default:
      return ''
  }
}
