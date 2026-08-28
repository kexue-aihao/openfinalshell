import { SENTINEL } from './script'

/**
 * `ss -tinH` 的原始输出可能随连接数线性增长，不能直接穿过 SSH 通道。
 * 这里先在服务器端按本机 TCP 端口聚合累计字节数，主进程只收到很小的一张端口表。
 *
 * `bytes_sent` / `bytes_received` 是 Linux TCP_INFO 的单 socket 累计计数；端口页在
 * 相邻采样间做差得到速率。没有 `ss` 的极简系统返回 NOSS 哨兵，由调用方明确降级。
 */
const PORT_AGG_AWK = String.raw`
function flush() {
  if (port == "") return
  conns[port]++
  rx[port] += received
  tx[port] += sent
}
$1 ~ /^(ESTAB|SYN-SENT|SYN-RECV|FIN-WAIT-1|FIN-WAIT-2|TIME-WAIT|CLOSE|CLOSE-WAIT|LAST-ACK|LISTEN|CLOSING)$/ {
  flush()
  endpoint = $4
  sub(/^.*:/, "", endpoint)
  port = (endpoint ~ /^[0-9]+$/ && endpoint >= 1 && endpoint <= 65535) ? endpoint : ""
  sent = 0
  received = 0
  next
}
{
  for (i = 1; i <= NF; i++) {
    if ($i ~ /^bytes_sent:/) {
      value = $i
      sub(/^bytes_sent:/, "", value)
      if (value ~ /^[0-9]+$/) sent = value
    } else if ($i ~ /^bytes_received:/) {
      value = $i
      sub(/^bytes_received:/, "", value)
      if (value ~ /^[0-9]+$/) received = value
    }
  }
}
END {
  flush()
  for (p in conns) printf "%s %d %.0f %.0f\\n", p, conns[p], rx[p], tx[p]
}`.trim()

/** 一帧端口统计；正文行格式为 `port connections rxBytes txBytes`。 */
export function buildPortTrafficFrame(seq: number): string {
  return [
    `echo "${SENTINEL.begin(seq)}"`,
    `echo "${SENTINEL.section('PORTS')}"`,
    'if command -v ss >/dev/null 2>&1; then',
    `ss -tinH 2>/dev/null | awk '${PORT_AGG_AWK.replace(/'/g, "'\\''")}'`,
    'else',
    `echo "${SENTINEL.section('NOSS')}"`,
    'fi',
    `echo "${SENTINEL.end(seq)}"`
  ].join('\n') + '\n'
}
