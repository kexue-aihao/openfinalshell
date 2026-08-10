import { t } from '../services/i18n'

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
/**
 * 开新 channel 失败时的文案。
 *
 * 单独一条是因为它的排查方向和"连不上"完全不同：连接是好的、认证也过了，是**通道数**用满了。
 * sshd 的 MaxSessions 默认 10，而本项目一条会话常驻的 session 通道是
 * N 个 shell + 1 个浏览 SFTP + 1 个监控 exec，再加一次性命令就是 N+3 ——
 * 低配服务器上把 MaxSessions 调成 2 的不少见。ssh2 对这种失败给的原话是
 * "(SSH) Channel open failure: open failed"，照抄给用户等于什么都没说。
 */
export function channelOpenError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/channel open failure|open failed|administratively prohibited/i.test(msg)) {
    return t('err.ssh.channelOpenRejected')
  }
  return friendlySshError(err)
}

export function friendlySshError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)

  // 代理阶段的错误已经是成品文案，原样透出（否则代理的 ECONNREFUSED
  // 会被下面翻成"目标主机端口未开放"，把人指向错误的排查方向）
  if (err instanceof Error && err.name === 'ProxyError') return msg

  if (/All configured authentication methods failed/i.test(msg)) {
    return t('err.ssh.authFailed')
  }

  // ---- 私钥：先判"缺口令"，再判"口令错"，最后才是"格式不支持" ----
  if (/no passphrase given/i.test(msg) || /Encrypted private .*key detected/i.test(msg)) {
    return t('err.ssh.keyEncrypted')
  }
  if (/bad passphrase/i.test(msg) || /integrity check failed/i.test(msg)) {
    return t('err.ssh.keyBadPassphrase')
  }
  if (/Unsupported key format/i.test(msg) || /Cannot parse privateKey/i.test(msg)) {
    return t('err.ssh.keyUnsupportedFormat')
  }

  if (/no matching/i.test(msg)) {
    return t('err.ssh.noMatchingAlgo', { msg })
  }
  if (/ECONNREFUSED/.test(msg)) return t('err.ssh.connRefused')
  if (/ETIMEDOUT|Timed out/i.test(msg)) return t('err.ssh.timeout')
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return t('err.ssh.dnsResolveFail')
  if (/ECONNRESET/.test(msg)) return t('err.ssh.connReset')
  // TCP 通了但 SSH 握手还没开始就断了。这不是配置错误，方向是网络/代理/服务器侧：
  //   - 走了代理但代理没起/掉线（Clash、v2ray 等本地混合端口停了最常见）
  //   - 服务器在握手前就断开（sshd 的 MaxStartups、fail2ban 限流，或防火墙 RST）
  //   - 网络中途中断
  // 原文 "Connection lost before handshake" 对用户等于没说，给个能照着排查的方向
  if (/before handshake|handshake.*(fail|lost)|Connection lost/i.test(msg)) {
    return t('err.ssh.handshakeLost')
  }
  return msg
}
