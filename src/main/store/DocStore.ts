import { deepMerge } from './ConfigStore'
import { prepare, tx } from './Database'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('store')

/**
 * documents 表里的一份深层嵌套配置（settings 这类整体读写、不需要按行查询的数据）。
 *
 * 与旧的 JsonFileStore 保持相同的对外形状（data/set/update/flush），
 * 这样 settingsStore() 的调用方不用改。区别在于：
 * - 写入即落库（SQLite 单条 UPSERT 是原子的），不再 debounce + tmp/rename
 * - 读出时与默认值做**深合并**：旧实现是浅合并，新增嵌套字段在老配置上会读到 undefined
 */
export class DocStore<T extends object> {
  private cache: T | null = null
  private lastJson: string | undefined

  constructor(
    private readonly name: string,
    private readonly defaults: () => T
  ) {}

  get data(): T {
    const row = prepare('SELECT json FROM documents WHERE name = ?').get(this.name) as
      | { json: string }
      | undefined
    if (this.cache && this.lastJson === row?.json) return this.cache
    this.lastJson = row?.json
    if (!row) {
      this.cache = this.defaults()
      return this.cache
    }
    try {
      this.cache = deepMerge(this.defaults(), JSON.parse(row.json))
    } catch (err) {
      log.error(`document ${this.name} unreadable, falling back to defaults`, err)
      this.cache = this.defaults()
    }
    return this.cache
  }

  set(next: T): void {
    this.persist(next)
    this.cache = next
  }

  update(mutate: (draft: T) => void): T {
    return tx(() => {
      const draft = structuredClone(this.data)
      mutate(draft)
      this.set(draft)
      return draft
    })
  }

  private persist(value: T): void {
    const json = JSON.stringify(value)
    prepare(
      'INSERT INTO documents(name, json) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET json = ?'
    ).run(this.name, json, json)
    this.lastJson = json
  }

  /** 写入是同步落库的，保留此方法只为兼容退出前的 flush 调用 */
  async flush(): Promise<void> {
    /* no-op */
  }
}
