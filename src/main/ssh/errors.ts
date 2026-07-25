/** 把 ssh2 的原始报错翻译成用户能懂的文案（纯函数，可单测） */
export function friendlySshError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/All configured authentication methods failed/i.test(msg)) {
    return '认证失败：用户名、密码或密钥不正确'
  }
  if (/Encrypted private key detected, but no passphrase/i.test(msg)) {
    return '私钥已加密，请在连接配置中填写私钥口令'
  }
  if (/Cannot parse privateKey/i.test(msg)) {
    if (/bad passphrase|decrypt|Bad passphrase/i.test(msg)) return '私钥口令错误'
    return '私钥格式不支持（支持 OpenSSH/PEM/PPK v2；PPK v3 请用 puttygen 另存为 v2）'
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
