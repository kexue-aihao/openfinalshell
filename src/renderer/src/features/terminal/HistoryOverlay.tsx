import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Empty, Input, Popconfirm } from 'antd'
import { Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { filterHistory, useHistoryStore } from '@/stores/useHistoryStore'
import styles from './HistoryOverlay.module.css'

interface Props {
  /** 回填到命令行。**不带回车** —— 理由见 onPick 的注释 */
  onInsert: (command: string) => void
  onClose: () => void
}

/**
 * 命令历史浮层（Ctrl+Shift+H 或悬浮工具条）。位置贴着终端底部，
 * 与"命令行就在下面"这件事对齐：过滤框在最下面，列表往上长。
 *
 * **点一条只回填、绝不自动回车。** 这不是漏了一步：列表里躺着的是用户自己在生产服务器上
 * 敲过的原话，其中完全可能有 `rm -rf`、`systemctl stop`、`DROP TABLE`。一个列表里
 * 单击就执行，等于把误点的代价定在"生产事故"这一档。回填之后光标就在行尾，
 * 想执行再按一下回车 —— 多一次按键换掉整类事故。
 */
export function HistoryOverlay({ onInsert, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const entries = useHistoryStore((s) => s.entries)
  const loaded = useHistoryStore((s) => s.loaded)
  const load = useHistoryStore((s) => s.load)
  const clear = useHistoryStore((s) => s.clear)
  const [keyword, setKeyword] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<React.ComponentRef<typeof Input>>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    // 浮层可能是这一进程里第一次要用历史 —— 没读过就先读一次
    if (!loaded) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visible = useMemo(() => filterHistory(entries, keyword), [entries, keyword])

  // 过滤变窄之后旧下标可能已经越界；夹回来而不是留一个指向空气的高亮
  const index = visible.length === 0 ? -1 : Math.min(active, visible.length - 1)

  useEffect(() => {
    if (index < 0) return
    listRef.current?.querySelectorAll('[data-row]')[index]?.scrollIntoView({ block: 'nearest' })
  }, [index])

  /** 回填并收起。**不追加 '\n'** —— 见组件头部那段 */
  const onPick = (command: string): void => {
    onInsert(command)
    onClose()
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.head}>
        <span className={styles.title}>{t('terminal.history')}</span>
        <span className={styles.hint}>{t('terminal.historyHint')}</span>
        <Popconfirm
          title={t('terminal.historyClearConfirm')}
          okText={t('common.ok')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
          onConfirm={() => void clear()}
        >
          <Button size="small" type="text" icon={<Trash2 size={13} strokeWidth={1.75} />}>
            {t('terminal.historyClear')}
          </Button>
        </Popconfirm>
        <Button size="small" type="text" icon={<X size={14} strokeWidth={1.75} />} onClick={onClose} />
      </div>

      <div className={styles.list} ref={listRef}>
        {visible.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={keyword ? t('terminal.historyNoMatch') : t('terminal.historyEmpty')}
            style={{ margin: '12px 0' }}
          />
        ) : (
          visible.map((entry, i) => (
            <div
              key={entry.command}
              data-row
              className={`${styles.row} ${i === index ? styles.rowActive : ''}`}
              title={entry.command}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(entry.command)}
            >
              <span className={styles.cmd}>{entry.command}</span>
              {entry.useCount > 1 && <span className={styles.count}>×{entry.useCount}</span>}
            </div>
          ))
        )}
      </div>

      <Input
        ref={inputRef}
        size="small"
        placeholder={t('terminal.historyFilter')}
        value={keyword}
        onChange={(e) => {
          setKeyword(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          // 方向键与回车都由这里接管：焦点在过滤框上，列表自己收不到键
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((v) => Math.min(v + 1, Math.max(0, visible.length - 1)))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((v) => Math.max(0, v - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (index >= 0) onPick(visible[index].command)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
    </div>
  )
}
