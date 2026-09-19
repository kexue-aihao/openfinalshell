package io.github.openfinalshell.android.core.monitor

/**
 * Produces the sentinel-delimited collection frames that [MonitorSession] executes and parses.
 *
 * The seam exists because the frames are not portable. A remote Linux server answers `/proc/net/tcp`,
 * `ss -ntinH`, `ps -eo ... --sort` and `/etc/os-release`; an Android device answers a different, and
 * tier-dependent, subset. Splitting the *source* of the frame from its *collection and parsing*
 * keeps every parser unchanged and keeps SSH monitoring byte-for-byte identical.
 */
interface MonitorFrameSource {
    /**
     * Which metrics this source can produce.
     *
     * Defaults to everything, which is correct for a remote Linux server. A source that can only
     * answer part of the frame overrides it so the UI can say "unavailable here" instead of
     * rendering an absent section as a real zero.
     */
    val availability: MonitorAvailability get() = MonitorAvailability()

    /**
     * One collection frame. [tick] selects the periodic sections — the frame includes `df` and `ps`
     * only on some ticks, matching what the desktop client does.
     */
    fun frame(sequence: Long, tick: Int): String

    /** The one-shot static frame: kernel, hostname, cores, distro and addresses. */
    fun staticFrame(): String

    /** Per-port byte counters, or null when this session cannot collect them at all. */
    fun portTraffic(sequence: Long): String?
}

/**
 * The frame a remote Linux server answers, unchanged.
 *
 * The capability arguments keep the optimistic defaults this app has always used, because the
 * Android SSH path has never probed the remote shell; only local sessions probe. Pinning that here
 * with a byte-equality test is what makes the local work unable to disturb remote monitoring.
 */
object LinuxMonitorFrameSource : MonitorFrameSource {
    override fun frame(sequence: Long, tick: Int): String =
        MonitorCommandBuilder.frame(sequence, tick % DF_TICKS == 0, tick % PS_TICKS == 0)

    override fun staticFrame(): String = MonitorCommandBuilder.staticFrame()

    override fun portTraffic(sequence: Long): String = MonitorCommandBuilder.portTraffic(sequence)

    private const val DF_TICKS = 5
    private const val PS_TICKS = 3
}

/** How much of `ps` the local shell actually supports. */
enum class PsFlavour { NONE, AUX, EXTENDED, SORTED }

/**
 * What a local session's shell can actually collect.
 *
 * This is a probe *result*, not an assumption. `/proc` hardening differs by API level and by vendor,
 * and an unreadable file must present as "unavailable at this tier" rather than as a wrong number.
 */
data class LocalCapabilities(
    /** The uid the shell is running as, which is what the tier badge is derived from. */
    val uid: Int,
    /** Sentinel names this shell can produce, e.g. `STAT`, `MEM`, `DF`. */
    val sections: Set<String>,
    val hasTimeout: Boolean,
    val hasAwk: Boolean,
    val hasPsSort: Boolean,
    val psFlavour: PsFlavour,
    val tcpTableReadable: Boolean
) {
    companion object {
        /** What an app-uid shell on a modern Android release typically manages. Used when probing fails. */
        val UNPROBED = LocalCapabilities(
            uid = -1,
            sections = setOf("STAT", "MEM", "NET", "UPTIME", "LOAD"),
            hasTimeout = false,
            hasAwk = false,
            hasPsSort = false,
            psFlavour = PsFlavour.NONE,
            tcpTableReadable = false
        )
    }
}

/**
 * Builds a frame from what the probe found.
 *
 * Two panels are unavailable at every local tier and say so rather than showing zeroes:
 * - **Port traffic** needs `ss -ntinH`'s `bytes_sent:`/`bytes_received:` fields. Android ships no
 *   `ss`, and nothing else exposes `TCP_INFO` for another process's sockets.
 * - **TCP connection states** need both a readable `/proc/net/tcp` — denied to an app-uid process on
 *   modern Android — and a `toybox awk` that is not guaranteed to be present.
 */
class LocalMonitorFrameSource(private val capabilities: LocalCapabilities) : MonitorFrameSource {
    override val availability: MonitorAvailability
        get() = MonitorAvailability(
            memory = "MEM" in capabilities.sections,
            disk = "DF" in capabilities.sections,
            processes = capabilities.psFlavour != PsFlavour.NONE,
            tcpStates = capabilities.tcpTableReadable && capabilities.hasAwk,
            portTraffic = false
        )

    override fun frame(sequence: Long, tick: Int): String {
        val lines = mutableListOf("printf '%s\\n' '@@OFS:BEGIN:$sequence@@'")
        for ((section, command) in COLLECTORS) {
            if (section !in capabilities.sections) continue
            lines += "printf '%s\\n' '@@OFS:$section@@'"
            lines += command
        }
        if ("DF" in capabilities.sections && tick % DF_TICKS == 0) {
            lines += "printf '%s\\n' '@@OFS:DF@@'"
            lines += withTimeout("df -kP 2>/dev/null")
        }
        if (capabilities.tcpTableReadable && capabilities.hasAwk && tick % DF_TICKS == 0) {
            lines += "printf '%s\\n' '@@OFS:TCPST@@'"
            lines += withTimeout(TCP_STATE_AWK)
        }
        if (tick % PS_TICKS == 0) {
            psCommand()?.let { command ->
                lines += "printf '%s\\n' '@@OFS:PS@@'"
                lines += command
            }
        }
        lines += "printf '%s\\n' '@@OFS:END:$sequence@@'"
        return lines.joinToString("\n") + "\n"
    }

    /**
     * Android-shaped static info.
     *
     * `LinuxMonitorParser.parseStatic` is reused unchanged: it looks for `PRETTY_NAME` (or `NAME`) in
     * the os-release section, so an Android description is emitted in that shape rather than adding a
     * second parser.
     */
    override fun staticFrame(): String = listOf(
        "printf '%s\\n' '@@OFS:BEGIN:0@@'",
        "printf '%s\\n' '@@OFS:UNAME@@'", "uname -srm 2>/dev/null",
        "printf '%s\\n' '@@OFS:HOSTNAME@@'", "getprop ro.product.model 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null",
        "printf '%s\\n' '@@OFS:NPROC@@'", "nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null",
        "printf '%s\\n' '@@OFS:OSRELEASE@@'", ANDROID_RELEASE,
        "printf '%s\\n' '@@OFS:IPADDR@@'", "ifconfig 2>/dev/null || ip -o -4 addr 2>/dev/null",
        "printf '%s\\n' '@@OFS:END:0@@'"
    ).joinToString("\n") + "\n"

    /** Null at every local tier: see the class note about `ss`. */
    override fun portTraffic(sequence: Long): String? = null

    private fun psCommand(): String? = when (capabilities.psFlavour) {
        PsFlavour.SORTED -> "ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 9"
        // toybox ps takes -o but ignores --sort, so the CPU ordering has to be done by the consumer.
        PsFlavour.EXTENDED -> "ps -eo pid,pcpu,pmem,comm 2>/dev/null | head -n 9"
        PsFlavour.AUX -> "ps aux 2>/dev/null | sed 1d | sort -rnk3 2>/dev/null | head -n 8"
        PsFlavour.NONE -> null
    }

    /** `timeout` is a toybox applet on modern Android but is not guaranteed, and a hung collector
     *  would stall the whole tick rather than one section. */
    private fun withTimeout(command: String): String =
        if (capabilities.hasTimeout) "timeout 3 $command" else command

    private companion object {
        const val DF_TICKS = 5
        const val PS_TICKS = 3

        const val TCP_STATE_AWK =
            "awk 'FNR>1{c[\$4]++} END{for(k in c) printf \"%s %d\\n\", k, c[k]}' /proc/net/tcp /proc/net/tcp6 2>/dev/null"

        const val ANDROID_RELEASE =
            "printf 'PRETTY_NAME=\"Android %s (%s)\"\\n' \"\$(getprop ro.build.version.release 2>/dev/null)\" \"\$(getprop ro.product.model 2>/dev/null)\""

        /** Ordered so the frame reads like the Linux one. Every read is guarded: an unreadable file
         *  must produce an empty section, never a failure that aborts the tick. */
        val COLLECTORS = listOf(
            "STAT" to "cat /proc/stat 2>/dev/null",
            "MEM" to "cat /proc/meminfo 2>/dev/null",
            "NET" to "cat /proc/net/dev 2>/dev/null",
            "UPTIME" to "cat /proc/uptime 2>/dev/null",
            "LOAD" to "cat /proc/loadavg 2>/dev/null",
            "DISKIO" to "cat /proc/diskstats 2>/dev/null",
            "SOCK" to "cat /proc/net/sockstat /proc/net/sockstat6 2>/dev/null"
        )
    }
}
