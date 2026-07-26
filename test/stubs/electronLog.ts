/* eslint-disable no-console */
/**
 * vitest 用的 electron-log 桩。
 *
 * 为什么必须桩掉：electron-log 在 electron 桩环境下拿不到真正的 app，会退回用
 * `process.env.APPDATA` 拼日志路径 —— 于是跑单测会往**用户真实的**
 * `%APPDATA%\openfinalshell\logs\main.log` 里写行。
 *
 * 这不只是脏。排查线上问题时，测试写进去的行会把用户自己的日志顶掉/盖住，
 * 真出过事：一次连接故障排查里，正是这些测试日志让人误以为应用"什么都没记"。
 *
 * error 仍转发到 console，测试失败时不至于把线索一起吞掉。
 */
const noop = (): void => {}

function makeScope(name?: string): Record<string, (...args: unknown[]) => void> {
  const tag = name ? `(${name})` : ''
  return {
    info: noop,
    warn: noop,
    debug: noop,
    verbose: noop,
    silly: noop,
    error: (...args: unknown[]) => console.error(`[test-log]${tag}`, ...args)
  }
}

const log = {
  initialize: noop,
  transports: {
    file: { level: 'info' as string | false, maxSize: 0, resolvePathFn: noop },
    console: { level: 'info' as string | false }
  },
  hooks: [] as unknown[],
  scope: makeScope,
  ...makeScope()
}

export default log
