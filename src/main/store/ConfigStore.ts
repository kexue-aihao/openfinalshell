import { existsSync, readFileSync, renameSync } from 'node:fs'
import { atomicWriteFile } from '../utils/atomicWrite'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('store')

/**
 * 自管 JSON 配置文件：同步加载（启动期一次）、debounce 落盘、原子写。
 * 文件损坏时把原文件备份为 *.corrupt 并回退默认值，绝不让启动失败。
 */
export class JsonFileStore<T extends { version: number }> {
  private _data: T
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(
    private readonly filePath: string,
    private readonly defaults: () => T,
    private readonly debounceMs = 500
  ) {
    this._data = this.load()
  }

  private load(): T {
    if (!existsSync(this.filePath)) return this.defaults()
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as T
      // 预留版本迁移点：parsed.version < defaults().version 时逐版本升级
      return { ...this.defaults(), ...parsed }
    } catch (err) {
      log.error(`config file corrupt, backing up: ${this.filePath}`, err)
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt`)
      } catch {
        /* 备份失败不阻塞启动 */
      }
      return this.defaults()
    }
  }

  get data(): T {
    return this._data
  }

  /** 整体替换并调度落盘 */
  set(next: T): void {
    this._data = next
    this.scheduleSave()
  }

  /** 变更并调度落盘 */
  update(mutate: (draft: T) => void): T {
    mutate(this._data)
    this.scheduleSave()
    return this._data
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, this.debounceMs)
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      await atomicWriteFile(this.filePath, JSON.stringify(this._data, null, 2))
    } catch (err) {
      this.dirty = true
      log.error(`failed to persist ${this.filePath}`, err)
    }
  }
}

/** 深合并（仅普通对象递归；数组与标量整体替换），用于 settings 局部更新 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (
    base === null ||
    patch === null ||
    typeof base !== 'object' ||
    typeof patch !== 'object' ||
    Array.isArray(base) ||
    Array.isArray(patch)
  ) {
    return patch as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v)
  }
  return out as T
}
