import { useEffect, useRef, useState } from 'react'
import { Alert, Checkbox, Form, Input, Modal, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type {
  HostkeyPromptPayload,
  KbiPromptPayload,
  PasswordPromptPayload,
  RdpCertificatePromptPayload,
  RdpPasswordPromptPayload,
  SessionPrompt
} from '@shared/types'
import { ofs } from '@/ipc/api'

/**
 * 认证/信任交互宿主：订阅 session:prompt，渲染对应 Modal，应答走 session:promptReply。
 * main 侧 PromptBroker 串行派发，同一时刻至多一个 prompt。
 */
export function PromptHost(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState<SessionPrompt | null>(null)
  const [answers, setAnswers] = useState<string[]>([])
  const [remember, setRemember] = useState(false)
  const repliedRef = useRef(false)

  useEffect(() => {
    return ofs.on('session:prompt', (p) => {
      repliedRef.current = false
      setAnswers([])
      setRemember(p.kind === 'password' || p.kind === 'rdp-password')
      setPrompt(p)
    })
  }, [])

  if (!prompt) return null

  const reply = (ok: boolean, extra?: { answers?: string[]; remember?: boolean }): void => {
    if (repliedRef.current) return
    repliedRef.current = true
    void ofs.invoke('session:promptReply', {
      requestId: prompt.requestId,
      ok,
      answers: extra?.answers,
      remember: extra?.remember
    })
    setPrompt(null)
  }

  // ---------- hostkey ----------
  if (prompt.kind === 'hostkey-new' || prompt.kind === 'hostkey-changed') {
    const p = prompt.payload as HostkeyPromptPayload
    const changed = prompt.kind === 'hostkey-changed'
    return (
      <Modal
        open
        title={changed ? t('prompt.hostkeyChangedTitle') : t('prompt.hostkeyNewTitle')}
        okText={changed ? t('prompt.trustNew') : t('prompt.trustAlways')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: changed }}
        onOk={() => reply(true, { remember: true })}
        onCancel={() => reply(false)}
        footer={(_, { OkBtn, CancelBtn }) => (
          <>
            <CancelBtn />
            {!changed && (
              <a style={{ margin: '0 12px' }} onClick={() => reply(true, { remember: false })}>
                {t('prompt.trustOnce')}
              </a>
            )}
            <OkBtn />
          </>
        )}
      >
        {changed && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('prompt.hostkeyChangedWarning')}
          />
        )}
        <p>
          {t('prompt.hostkeyTarget')}: {p.host}:{p.port}（{p.keyType}）
        </p>
        <Typography.Paragraph copyable code style={{ wordBreak: 'break-all' }}>
          {p.fingerprintSha256}
        </Typography.Paragraph>
        {p.previousFingerprint && (
          <p style={{ color: 'var(--ofs-text-2)' }}>
            {t('prompt.hostkeyPrevious')}: {p.previousFingerprint}
          </p>
        )}
      </Modal>
    )
  }

  // ---------- 一次性密码 ----------
  if (prompt.kind === 'password' || prompt.kind === 'rdp-password') {
    const p = prompt.payload as PasswordPromptPayload | RdpPasswordPromptPayload
    return (
      <Modal
        open
        title={t('prompt.passwordTitle', { target: `${p.username}@${p.host}` })}
        okText={t('common.ok')}
        cancelText={t('common.cancel')}
        onOk={() => reply(true, { answers: [answers[0] ?? ''], remember })}
        onCancel={() => reply(false)}
      >
        <Input.Password
          autoFocus
          placeholder={t('prompt.passwordPlaceholder')}
          value={answers[0] ?? ''}
          onChange={(e) => setAnswers([e.target.value])}
          onPressEnter={() => reply(true, { answers: [answers[0] ?? ''], remember })}
        />
        <Checkbox
          style={{ marginTop: 12 }}
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        >
          {t('prompt.rememberPassword')}
        </Checkbox>
      </Modal>
    )
  }

  // ---------- RDP certificate (one-time approval; no persistent trust store in v1) ----------
  if (prompt.kind === 'rdp-certificate') {
    const p = prompt.payload as RdpCertificatePromptPayload
    const changed = p.changed === true
    return (
      <Modal
        open
        title={changed ? t('prompt.hostkeyChangedTitle') : t('prompt.hostkeyNewTitle')}
        okText={t('prompt.trustOnce')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: changed }}
        onOk={() => reply(true)}
        onCancel={() => reply(false)}
      >
        {changed && <Alert type="warning" showIcon message={t('prompt.hostkeyChangedWarning')} />}
        <p>{t('prompt.hostkeyTarget')}: {p.host}:{p.port}</p>
        <p>{p.subject} ({p.issuer})</p>
        <Typography.Paragraph copyable code style={{ wordBreak: 'break-all' }}>
          {p.fingerprintSha256}
        </Typography.Paragraph>
      </Modal>
    )
  }

  // ---------- keyboard-interactive ----------
  const p = prompt.payload as KbiPromptPayload
  return (
    <Modal
      open
      title={p.title || t('prompt.kbiTitle')}
      okText={t('common.ok')}
      cancelText={t('common.cancel')}
      onOk={() => reply(true, { answers: p.prompts.map((_, i) => answers[i] ?? '') })}
      onCancel={() => reply(false)}
    >
      {p.instructions && <p style={{ whiteSpace: 'pre-wrap' }}>{p.instructions}</p>}
      <Form layout="vertical">
        {p.prompts.map((item, i) => (
          <Form.Item key={i} label={item.prompt} style={{ marginBottom: 12 }}>
            {item.echo ? (
              <Input
                autoFocus={i === 0}
                value={answers[i] ?? ''}
                onChange={(e) =>
                  setAnswers((prev) => {
                    const next = [...prev]
                    next[i] = e.target.value
                    return next
                  })
                }
              />
            ) : (
              <Input.Password
                autoFocus={i === 0}
                value={answers[i] ?? ''}
                onChange={(e) =>
                  setAnswers((prev) => {
                    const next = [...prev]
                    next[i] = e.target.value
                    return next
                  })
                }
              />
            )}
          </Form.Item>
        ))}
      </Form>
    </Modal>
  )
}
