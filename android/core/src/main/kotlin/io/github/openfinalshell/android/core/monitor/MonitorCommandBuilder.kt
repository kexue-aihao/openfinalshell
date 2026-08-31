package io.github.openfinalshell.android.core.monitor

/** Builds the same sentinel-delimited Linux collection commands as the desktop client. */
object MonitorCommandBuilder {
    private const val beginPrefix = "@@OFS:BEGIN:"
    private const val endSuffix = "@@"

    fun frame(seq: Long, withDf: Boolean, withPs: Boolean, hasTimeout: Boolean = true, hasPsSort: Boolean = true): String {
        val begin = "$beginPrefix$seq$endSuffix"
        val end = "@@OFS:END:$seq@@"
        val lines = mutableListOf(
            "printf '%s\\n' '$begin'",
            "printf '%s\\n' '@@OFS:STAT@@'", "cat /proc/stat 2>/dev/null",
            "printf '%s\\n' '@@OFS:MEM@@'", "cat /proc/meminfo 2>/dev/null",
            "printf '%s\\n' '@@OFS:NET@@'", "cat /proc/net/dev 2>/dev/null",
            "printf '%s\\n' '@@OFS:UPTIME@@'", "cat /proc/uptime 2>/dev/null",
            "printf '%s\\n' '@@OFS:LOAD@@'", "cat /proc/loadavg 2>/dev/null",
            "printf '%s\\n' '@@OFS:DISKIO@@'", "cat /proc/diskstats 2>/dev/null",
            "printf '%s\\n' '@@OFS:SOCK@@'", "cat /proc/net/sockstat /proc/net/sockstat6 2>/dev/null"
        )
        if (withDf) {
            lines += "printf '%s\\n' '@@OFS:DF@@'"
            lines += if (hasTimeout) "timeout 3 df -kP 2>/dev/null" else "df -kP 2>/dev/null"
            lines += "printf '%s\\n' '@@OFS:TCPST@@'"
            lines += if (hasTimeout) "timeout 3 awk 'FNR>1{c[\$4]++} END{for(k in c) printf \"%s %d\\n\", k, c[k]}' /proc/net/tcp /proc/net/tcp6 2>/dev/null"
                else "awk 'FNR>1{c[\$4]++} END{for(k in c) printf \"%s %d\\n\", k, c[k]}' /proc/net/tcp /proc/net/tcp6 2>/dev/null"
        }
        if (withPs) {
            lines += "printf '%s\\n' '@@OFS:PS@@'"
            lines += if (hasPsSort) "ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 9"
                else "ps aux 2>/dev/null | sed 1d | sort -rnk3 2>/dev/null | head -n 8"
        }
        lines += "printf '%s\\n' '$end'"
        return lines.joinToString("\n") + "\n"
    }

    fun staticFrame(): String = listOf(
        "printf '%s\\n' '@@OFS:BEGIN:0@@'",
        "printf '%s\\n' '@@OFS:UNAME@@'", "uname -srm 2>/dev/null",
        "printf '%s\\n' '@@OFS:HOSTNAME@@'", "hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null",
        "printf '%s\\n' '@@OFS:NPROC@@'", "nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null",
        "printf '%s\\n' '@@OFS:OSRELEASE@@'", "cat /etc/os-release 2>/dev/null",
        "printf '%s\\n' '@@OFS:IPADDR@@'", "ip -o -4 addr 2>/dev/null || ifconfig 2>/dev/null",
        "printf '%s\\n' '@@OFS:END:0@@'"
    ).joinToString("\n") + "\n"

    fun portTraffic(seq: Long): String = listOf(
        "printf '%s\\n' '@@OFS:BEGIN:$seq@@'",
        "printf '%s\\n' '@@OFS:PORTS@@'",
        "if command -v ss >/dev/null 2>&1; then",
        "ss -ntinH 2>/dev/null | awk 'function flush(){if(port==\"\")return; conns[port]++; rx[port]+=received; tx[port]+=sent; if(has_sent&&has_received) counters[port]++} \$1 ~ /^(ESTAB|SYN-SENT|SYN-RECV|FIN-WAIT-1|FIN-WAIT-2|TIME-WAIT|CLOSE|CLOSE-WAIT|LAST-ACK|LISTEN|CLOSING)$/ {flush(); endpoint=\$4; sub(/^.*:/,\"\",endpoint); port=(endpoint ~ /^[0-9]+$/&&endpoint<=65535)?endpoint:\"\"; sent=0;received=0;has_sent=0;has_received=0;next} {for(i=1;i<=NF;i++){if(\$i ~ /^bytes_sent:/){v=\$i;sub(/^bytes_sent:/,\"\",v);if(v~/^[0-9]+$/){sent=v;has_sent=1}} else if(\$i ~ /^bytes_received:/){v=\$i;sub(/^bytes_received:/,\"\",v);if(v~/^[0-9]+$/){received=v;has_received=1}}}} END{flush();for(p in conns)printf \"%s %d %.0f %.0f %d\\n\",p,conns[p],rx[p],tx[p],counters[p]+0}'",
        "else",
        "printf '%s\\n' '@@OFS:NOSS@@'",
        "fi",
        "printf '%s\\n' '@@OFS:END:$seq@@'"
    ).joinToString("\n") + "\n"
}
