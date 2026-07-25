/**
 * ssh2 私钥格式支持范围的事实校验。
 *
 * README 里对"支持哪些私钥格式"的声明必须与 ssh2 的实际行为一致，否则用户会拿着
 * 不被支持的私钥反复碰壁。这里用真实生成的各格式私钥跑 ssh2.utils.parseKey，
 * 把实际支持情况钉成断言 —— 升级 ssh2 后若行为变化，这里会先失败。
 *
 * OpenSSH 格式用系统 ssh-keygen 生成（Windows 10+ / Linux / macOS 自带）；
 * 找不到 ssh-keygen 时相关用例跳过。
 */
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import ssh2 from 'ssh2'
import { friendlySshError } from '../../src/main/ssh/errors'

const { parseKey } = ssh2.utils
const PASSPHRASE = 'test-passphrase-123'

let dir = ''
let hasSshKeygen = false

/** parseKey 出错时返回 Error 而非抛异常（ssh2 的 API 特性） */
function tryParse(key: string | Buffer, passphrase?: string): { ok: boolean; error?: string } {
  const result = passphrase === undefined ? parseKey(key) : parseKey(key, passphrase)
  if (result instanceof Error) return { ok: false, error: result.message }
  return { ok: true }
}

function sshKeygen(args: string[]): void {
  execFileSync('ssh-keygen', args, { stdio: 'pipe' })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ofs-keyfmt-'))
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'pipe' })
    hasSshKeygen = true
  } catch {
    // -? 会以非零码退出但只要能执行就算存在
    hasSshKeygen = existsSync('C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe') || process.platform !== 'win32'
  }
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('ssh2 支持的私钥格式', () => {
  it('OpenSSH 新格式 ed25519（无口令）—— 支持', () => {
    if (!hasSshKeygen) return
    const path = join(dir, 'openssh_ed25519')
    sshKeygen(['-t', 'ed25519', '-N', '', '-C', 'test', '-f', path])
    expect(tryParse(readFileSync(path)).ok).toBe(true)
  })

  it('OpenSSH 新格式 ed25519（带口令）—— 支持，且口令错误有明确报错', () => {
    if (!hasSshKeygen) return
    const path = join(dir, 'openssh_ed25519_pw')
    sshKeygen(['-t', 'ed25519', '-N', PASSPHRASE, '-C', 'test', '-f', path])
    const key = readFileSync(path)
    expect(tryParse(key, PASSPHRASE).ok).toBe(true)

    // 口令错误必须翻成"私钥口令错误"，而不是笼统的格式不支持
    const wrong = tryParse(key, 'wrong-passphrase')
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toMatch(/integrity check failed/)
    expect(friendlySshError(new Error(wrong.error!))).toBe('私钥口令错误')

    // 加密私钥不给口令：ssh2 说的是 "Encrypted private OpenSSH key detected..."，
    // 必须提示去填口令而不是说格式不支持
    const noPass = tryParse(key)
    expect(noPass.ok).toBe(false)
    expect(friendlySshError(new Error(noPass.error!))).toBe('私钥已加密，请在连接配置中填写私钥口令')
  })

  it('OpenSSH 新格式 RSA（带口令）—— 支持', () => {
    if (!hasSshKeygen) return
    const path = join(dir, 'openssh_rsa_pw')
    sshKeygen(['-t', 'rsa', '-b', '2048', '-N', PASSPHRASE, '-C', 'test', '-f', path])
    expect(tryParse(readFileSync(path), PASSPHRASE).ok).toBe(true)
  })

  it('传统 PEM RSA（PKCS#1，无口令）—— 支持', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'der' }
    })
    expect(tryParse(privateKey as string).ok).toBe(true)
  })

  it('传统 PEM RSA（PKCS#1，带口令）—— 支持，口令错误可识别', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-128-cbc', passphrase: PASSPHRASE },
      publicKeyEncoding: { type: 'spki', format: 'der' }
    })
    expect(tryParse(privateKey as string, PASSPHRASE).ok).toBe(true)
    const wrong = tryParse(privateKey as string, 'wrong')
    expect(wrong.ok).toBe(false)
    expect(friendlySshError(new Error(wrong.error!))).toBe('私钥口令错误')
  })

  it('PKCS#8 PEM —— 不支持（已知限制，须与 README 一致）', () => {
    for (const encoding of [
      { type: 'pkcs8' as const, format: 'pem' as const },
      {
        type: 'pkcs8' as const,
        format: 'pem' as const,
        cipher: 'aes-256-cbc',
        passphrase: PASSPHRASE
      }
    ]) {
      const { privateKey } = generateKeyPairSync('ed25519', {
        privateKeyEncoding: encoding,
        publicKeyEncoding: { type: 'spki', format: 'der' }
      })
      const result = tryParse(privateKey as string, PASSPHRASE)
      // 钉住"不支持"：一旦 ssh2 将来支持了，这里会失败并提醒更新文档
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/Unsupported key format/)
      // 文案必须指向格式问题并给出转换命令
      expect(friendlySshError(new Error(result.error!))).toContain('ssh-keygen -p')
    }
  })

  it('垃圾内容 —— 报错而不是崩溃', () => {
    const result = tryParse('not a key at all')
    expect(result.ok).toBe(false)
    expect(friendlySshError(new Error(result.error!)).length).toBeGreaterThan(0)
  })
})
