import { Button, Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import { isShellBlock, parseAiAnswer } from './aiAnswer'
import styles from './AiResponse.module.css'

interface Props {
  answer: string
  busy: boolean
  onCopy: (text: string) => void
  onInsert: (text: string) => void
  insertIssue: (text: string) => string | undefined
}

export function AiResponse({ answer, busy, onCopy, onInsert, insertIssue }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const actions = (text: string, shell: boolean, complete: boolean, whole = false): React.JSX.Element => {
    const reason = busy || !complete ? t('aiCommands.waitForCompletion') : insertIssue(text)
    return <div className={styles.actions}>
      <Button size="small" disabled={!text} onClick={() => onCopy(text)}>{whole ? t('aiCommands.copyBlock') : t('aiCommands.copy')}</Button>
      {shell && <Tooltip title={reason ?? t('aiCommands.manualEnter')}>
        <span><Button size="small" disabled={!!reason} onClick={() => onInsert(text)}>{whole ? t('aiCommands.insertBlock') : t('aiCommands.insertToSsh')}</Button></span>
      </Tooltip>}
    </div>
  }
  return <div className={styles.answer} aria-label={t('aiAssistant.answer')}>
    {parseAiAnswer(answer).map((part, index) => {
      if (part.kind === 'text') return <div key={index} className={styles.prose}>{part.text}</div>
      const shell = isShellBlock(part.language)
      const lines = part.text.split('\n')
      return <div key={index} className={styles.block}>
        <div className={styles.header}>
          <span>{part.language || t('aiCommands.code')}</span>
          {actions(part.text, shell, part.complete, lines.length > 1)}
        </div>
        {shell && lines.length > 1 ? lines.map((line, lineIndex) => <div className={styles.line} key={lineIndex}>
          <pre>{line || ' '}</pre>
          {line.trim() && !line.trimStart().startsWith('#') && actions(line, true, part.complete)}
        </div>) : <pre className={styles.code}>{part.text}</pre>}
      </div>
    })}
  </div>
}
