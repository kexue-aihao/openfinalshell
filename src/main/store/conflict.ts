export function assertRevision(expected: number | undefined, actual: number | undefined): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error('配置已被另一个窗口修改或删除，请重新加载后保存（CONFIG_CONFLICT）')
  }
}

export function nextRevision(previous?: number): number {
  return Math.max(Date.now(), (previous ?? 0) + 1)
}
