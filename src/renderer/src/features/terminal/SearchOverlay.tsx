import { useEffect, useRef, useState } from 'react'
import { Button, Input } from 'antd'
import { CaseSensitive, ChevronDown, ChevronUp, Regex, X } from 'lucide-react'
import type { SearchAddon } from '@xterm/addon-search'
import { useTranslation } from 'react-i18next'
import { TitlebarSafeTooltip } from '@/components/TitlebarSafeTooltip'
import styles from './SearchOverlay.module.css'

interface Props {
  search: SearchAddon
  accent: string
  onClose: () => void
}

/** Ctrl+F 浮出的终端搜索条：匹配计数 + 大小写 + 正则 + 高亮装饰 */
export function SearchOverlay({ search, accent, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [keyword, setKeyword] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [result, setResult] = useState<{ index: number; count: number }>({ index: -1, count: 0 })
  const inputRef = useRef<React.ComponentRef<typeof Input>>(null)

  const options = {
    caseSensitive,
    regex,
    decorations: {
      matchOverviewRuler: accent,
      activeMatchColorOverviewRuler: accent,
      matchBackground: `${accent}55`,
      activeMatchBackground: accent
    }
  }

  useEffect(() => {
    inputRef.current?.focus()
    const dispose = search.onDidChangeResults((r) =>
      setResult({ index: r.resultIndex, count: r.resultCount })
    )
    return () => dispose.dispose()
  }, [search])

  useEffect(() => {
    if (keyword) search.findNext(keyword, { ...options, incremental: true })
    else {
      search.clearDecorations()
      setResult({ index: -1, count: 0 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, caseSensitive, regex])

  const close = (): void => {
    search.clearDecorations()
    onClose()
  }

  return (
    <div className={styles.overlay}>
      <Input
        ref={inputRef}
        size="small"
        placeholder={t('terminal.searchPlaceholder')}
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onPressEnter={(e) => {
          if (e.shiftKey) search.findPrevious(keyword, options)
          else search.findNext(keyword, options)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
        }}
      />
      <span className={styles.count}>
        {result.count > 0 ? `${result.index + 1}/${result.count}` : keyword ? '0/0' : ''}
      </span>
      <TitlebarSafeTooltip title={t('terminal.searchPrev')}>
        <Button
          size="small"
          type="text"
          icon={<ChevronUp size={14} strokeWidth={1.75} />}
          onClick={() => search.findPrevious(keyword, options)}
        />
      </TitlebarSafeTooltip>
      <TitlebarSafeTooltip title={t('terminal.searchNext')}>
        <Button
          size="small"
          type="text"
          icon={<ChevronDown size={14} strokeWidth={1.75} />}
          onClick={() => search.findNext(keyword, options)}
        />
      </TitlebarSafeTooltip>
      <TitlebarSafeTooltip title={t('terminal.searchCase')}>
        <Button
          size="small"
          type={caseSensitive ? 'primary' : 'text'}
          icon={<CaseSensitive size={14} strokeWidth={1.75} />}
          onClick={() => setCaseSensitive((v) => !v)}
        />
      </TitlebarSafeTooltip>
      <TitlebarSafeTooltip title={t('terminal.searchRegex')}>
        <Button
          size="small"
          type={regex ? 'primary' : 'text'}
          icon={<Regex size={14} strokeWidth={1.75} />}
          onClick={() => setRegex((v) => !v)}
        />
      </TitlebarSafeTooltip>
      <Button size="small" type="text" icon={<X size={14} strokeWidth={1.75} />} onClick={close} />
    </div>
  )
}
