/**
 * 把 ssh2 的原始报错翻译成用户能懂的文案（纯函数，可单测）。
 *
 * 私钥相关的字符串以 ssh2 ^1.17 的实际输出为准（见 test/unit/privateKeyFormats.test.ts
 * 对真实私钥的探测）：Client 会把 parseKey 的错误包成 `Cannot parse privateKey: <原因>`，
 * 原因可能是：
 *   - Encrypted private OpenSSH key detected, but no passphrase given
 *   - OpenSSH key integrity check failed -- bad passphrase?
 *   - Malformed OpenSSH private key. Bad passphrase?
 *   - Unsupported key format（PKCS#8、损坏文件、非私钥内容都是这一条）
 */
export function friendlySshError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)

  if (/All configured authentication methods failed/i.test(msg)) {
    return '认证失败：用户名、密码或密钥不正确'
  }

  // ---- 私钥：先判"缺口令"，再判"口令错"，最后才是"格式不支持" ----
  if (/no passphrase given/i.test(msg) || /Encrypted private .*key detected/i.test(msg)) {
    return '私钥已加密，请在连接配置中填写私钥口令'
  }
  if (/bad passphrase/i.test(msg) || /integrity check failed/i.test(msg)) {
    return '私钥口令错误'
  }
  if (/Unsupported key format/i.test(msg) || /Cannot parse privateKey/i.test(msg)) {
    return (
      '私钥格式不支持：请使用 OpenSSH 格式或传统 PEM（BEGIN RSA PRIVATE KEY）。' +
      'PKCS#8（BEGIN PRIVATE KEY）可用 ssh-keygen -p -f <私钥> -m RFC4716 转换'
    )
  }

  if (/no matching/i.test(msg)) {
    return `算法协商失败（老设备可在连接设置中开启"兼容老算法"）：${msg}`
  }
  if (/ECONNREFUSED/.test(msg)) return '连接被拒绝：目标主机端口未开放'
  if (/ETIMEDOUT|Timed out/i.test(msg)) return '连接超时：主机不可达或网络受阻'
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return '无法解析主机名'
  if (/ECONNRESET/.test(msg)) return '连接被重置'
  return msg
}
