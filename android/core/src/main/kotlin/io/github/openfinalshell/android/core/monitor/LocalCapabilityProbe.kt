package io.github.openfinalshell.android.core.monitor

/**
 * Asks a local shell what it can actually collect, once per session.
 *
 * The Android counterpart of what the desktop client does by parsing `HASTIMEOUT`/`HASPSSORT` out
 * of its collection frame. Android needs it more: `/proc` visibility depends on the API level, on
 * SELinux and on the vendor, so which sections work is a property of the device and the tier, not
 * of the app. Guessing wrong shows a user a zero where the truth is "not readable here".
 */
object LocalCapabilityProbe {
    /**
     * Emits `key=value` lines between the standard frame sentinels, so the same extraction and
     * frame parser the monitor already uses can carry it.
     *
     * Every probe is `command -v` or a guarded read, deliberately: `mksh` plus toybox is the floor,
     * and a probe that itself errors must report "unavailable" rather than fail the session.
     */
    fun probeCommand(): String = listOf(
        "printf '%s\\n' '@@OFS:BEGIN:0@@'",
        "printf '%s\\n' '@@OFS:PROBE@@'",
        "printf 'uid=%s\\n' \"\$(id -u 2>/dev/null)\"",
        "printf 'timeout=%s\\n' \"\$(command -v timeout >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'awk=%s\\n' \"\$(command -v awk >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'df=%s\\n' \"\$(command -v df >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'stat=%s\\n' \"\$(cat /proc/stat >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'mem=%s\\n' \"\$(cat /proc/meminfo >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'net=%s\\n' \"\$(cat /proc/net/dev >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'uptime=%s\\n' \"\$(cat /proc/uptime >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'load=%s\\n' \"\$(cat /proc/loadavg >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'diskio=%s\\n' \"\$(cat /proc/diskstats >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'sock=%s\\n' \"\$(cat /proc/net/sockstat >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'tcp=%s\\n' \"\$(cat /proc/net/tcp >/dev/null 2>&1 && echo 1 || echo 0)\"",
        "printf 'pssort=%s\\n' \"\$(ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 1 | grep -q PID && echo 1 || echo 0)\"",
        "printf 'psext=%s\\n' \"\$(ps -eo pid,pcpu,pmem,comm 2>/dev/null | head -n 1 | grep -q PID && echo 1 || echo 0)\"",
        "printf 'psaux=%s\\n' \"\$(ps aux 2>/dev/null | head -n 1 | grep -q PID && echo 1 || echo 0)\"",
        "printf '%s\\n' '@@OFS:END:0@@'"
    ).joinToString("\n") + "\n"

    /**
     * Reads `key=value` pairs out of the probe output.
     *
     * Forgiving by design: unknown keys and any surrounding frame noise are ignored, and a missing
     * key means "unavailable" rather than an error. A probe that half-succeeds must still produce a
     * usable capability set.
     */
    fun parse(output: String): LocalCapabilities {
        val values = mutableMapOf<String, String>()
        output.lineSequence().forEach { raw ->
            val line = raw.trim()
            val separator = line.indexOf('=')
            if (separator <= 0) return@forEach
            val key = line.substring(0, separator)
            if (key.any { !it.isLetterOrDigit() && it != '_' }) return@forEach
            values[key] = line.substring(separator + 1).trim()
        }
        fun flag(key: String): Boolean = values[key] == "1"
        val sections = buildSet {
            if (flag("stat")) add("STAT")
            if (flag("mem")) add("MEM")
            if (flag("net")) add("NET")
            if (flag("uptime")) add("UPTIME")
            if (flag("load")) add("LOAD")
            if (flag("diskio")) add("DISKIO")
            if (flag("sock")) add("SOCK")
            if (flag("df")) add("DF")
        }
        val psFlavour = when {
            flag("pssort") -> PsFlavour.SORTED
            flag("psext") -> PsFlavour.EXTENDED
            flag("psaux") -> PsFlavour.AUX
            else -> PsFlavour.NONE
        }
        return LocalCapabilities(
            uid = values["uid"]?.toIntOrNull() ?: -1,
            sections = sections,
            hasTimeout = flag("timeout"),
            hasAwk = flag("awk"),
            hasPsSort = flag("pssort"),
            psFlavour = psFlavour,
            tcpTableReadable = flag("tcp")
        )
    }
}
