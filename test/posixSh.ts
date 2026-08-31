import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT_SH_TIMEOUT_MS = 20_000
const SH_MAX_BUFFER_BYTES = 8 * 1024 * 1024

type ShellExecError = Error & {
  code?: string | number
  signal?: string
  status?: number | null
  stdout?: unknown
  stderr?: unknown
}

function shellTimeoutMs(): number {
  const configured = Number(process.env.OFS_POSIX_SH_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_SH_TIMEOUT_MS
}

function outputText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/**
 * Git for Windows occasionally leaves an MSYS child stuck under CI load. Keep
 * that failure bounded and preserve the child output, rather than letting the
 * surrounding Vitest test timeout with no indication of which operation hung.
 */
function runSh(sh: string, args: string[], cwd: string | undefined, operation: string): string {
  try {
    const output = execFileSync(sh, args, {
      encoding: 'utf8',
      cwd,
      env: shEnv(sh),
      maxBuffer: SH_MAX_BUFFER_BYTES,
      timeout: shellTimeoutMs(),
      windowsHide: true
    })
    return String(output)
  } catch (error) {
    const failure = error as ShellExecError
    const stdout = outputText(failure.stdout)
    const stderr = outputText(failure.stderr)
    const diagnostics = [
      `[POSIX shell diagnostics] operation=${operation}`,
      `executable=${sh}`,
      `cwd=${cwd ?? process.cwd()}`,
      `timeoutMs=${shellTimeoutMs()}`,
      `code=${String(failure.code ?? '')}`,
      `status=${String(failure.status ?? '')}`,
      `signal=${String(failure.signal ?? '')}`,
      stdout ? `stdout:\n${stdout}` : '',
      stderr ? `stderr:\n${stderr}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    failure.message = `${failure.message}\n${diagnostics}`
    throw failure
  }
}

/**
 * 把生成的 shell 脚本交给一个**真的** POSIX shell 跑一遍，供 shellQuote / fastDelete /
 * packTransfer 三处的往返用例共用。
 *
 * 原先三个文件各抄了一份 findSh + execFileSync，直到踩了下面这个坑才提到一处 ——
 * 同一份代码在 Git Bash 里全绿、在 PowerShell 里 39 条红，而两边跑的是同一个 sh.exe。
 *
 * ⚠️ 脚本必须**写进文件再 `sh <文件>`**，不能 `sh -c <命令串>`：Windows 上
 * execFileSync 要把参数拼成一条命令行、MSYS 那侧再解析一次，反斜杠会在这中间被吃掉 ——
 * 那是宿主的参数传递问题，跟我们的转义无关（真实路径是 ssh2 把命令**原样**当字节发出去）。
 * 写文件绕开了整个宿主参数层，于是这里量到的就是"远端 shell 会怎么解析这段字节"。
 */
export function findSh(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          join(process.env.ProgramW6432 ?? 'C:\\Program Files', 'Git\\usr\\bin\\sh.exe'),
          'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
          'C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe'
        ]
      : ['/bin/sh']
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Windows 路径 → MSYS 能认的形式（C:\a\b → /c/a/b）。守卫要求前导 `/`，正好对上 */
export function toShellPath(p: string): string {
  if (process.platform !== 'win32') return p
  return `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}`
}

/**
 * 子 shell 的环境：把 sh 自己所在的目录**放到 PATH 最前面**。
 *
 * 这一行是必须的，而且踩过：Git for Windows 只把 `Git\cmd` 与 `Git\mingw64\bin`
 * 装进系统 PATH，`Git\usr\bin`（env / printf / tar / ls / wc 都在那儿）**不在**。
 * 于是从 PowerShell 启动测试时，MSYS sh 起来后连 `env` 都找不到 ——
 * 而我们所有远端命令都包成 `env LC_ALL=C LANG=C sh -c '…'`，第一个词就挂。
 * 从 Git Bash 启动则一切正常，因为它自己把 /usr/bin 铺好了。
 *
 * 结果就是"测试结果取决于谁启动了它"。不能靠调用方的 PATH：
 * 那既不可复现，也会在 CI 上以一堆看不懂的 `command not found` 出现。
 */
function shEnv(sh: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${dirname(sh)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` }
}

/** 跑一个脚本文件（被测对象走这条：与生产同一条包法） */
export function shFile(sh: string, file: string, cwd?: string): string {
  return runSh(sh, [file], cwd, 'shFile')
}

/** 跑一行命令。只给测试自己的辅助查询用（列归档成员、数残留文件），不用于被测对象 */
export function shCommand(sh: string, command: string, cwd?: string): string {
  return runSh(sh, ['-c', command], cwd, 'shCommand')
}
