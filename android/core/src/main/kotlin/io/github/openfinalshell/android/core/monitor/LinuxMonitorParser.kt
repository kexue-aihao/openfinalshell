package io.github.openfinalshell.android.core.monitor

import io.github.openfinalshell.android.core.model.ConnectionCounts
import io.github.openfinalshell.android.core.model.MemorySnapshot
import io.github.openfinalshell.android.core.model.NetworkSnapshot
import io.github.openfinalshell.android.core.model.MonitorStaticInfo

data class CpuTimes(val total: Long, val idle: Long)
data class DiskCounters(val dev: String, val readSectors: Long, val writeSectors: Long)
data class FsUsage(val fs: String, val mount: String, val totalKb: Long, val usedKb: Long, val usePct: Double)
data class ProcInfo(val pid: Int, val name: String, val cpuPct: Double, val memPct: Double)

private val realDisk = Regex("^(sd[a-z]|nvme\\d+n\\d+|vd[a-z]|xvd[a-z]|hd[a-z]|mmcblk\\d+)$")
private val skipFs = Regex("^(tmpfs|devtmpfs|udev|overlay|squashfs|none|shm|cgroup)")

object LinuxMonitorParser {
    fun parseCpu(text: String): Pair<CpuTimes, List<CpuTimes>>? {
        var all: CpuTimes? = null
        val cores = mutableListOf<CpuTimes>()
        text.lineSequence().forEach { line ->
            val fields = line.trim().split(Regex("\\s+"))
            if (fields.isEmpty() || !fields[0].startsWith("cpu")) return@forEach
            val numbers = fields.drop(1).mapNotNull { it.toLongOrNull() }
            if (numbers.size < 4) return@forEach
            val times = CpuTimes(numbers.sum(), numbers.getOrElse(3) { 0 } + numbers.getOrElse(4) { 0 })
            if (fields[0] == "cpu") all = times else cores += times
        }
        return all?.let { it to cores }
    }

    fun usage(previous: CpuTimes, current: CpuTimes): Double {
        val totalDelta = current.total - previous.total
        if (totalDelta <= 0) return 0.0
        return ((1.0 - (current.idle - previous.idle).toDouble() / totalDelta) * 100.0)
            .coerceIn(0.0, 100.0)
            .let { kotlin.math.round(it * 10) / 10 }
    }

    fun parseMeminfo(text: String): MemorySnapshot? {
        val values = text.lineSequence().mapNotNull { line ->
            val match = Regex("^(\\w+):\\s+(\\d+)").find(line.trim()) ?: return@mapNotNull null
            match.groupValues[1] to match.groupValues[2].toLong()
        }.toMap()
        val total = values["MemTotal"] ?: return null
        val buffers = values["Buffers"] ?: 0
        val cached = values["Cached"] ?: 0
        val reclaimable = values["SReclaimable"] ?: 0
        val available = values["MemAvailable"] ?: ((values["MemFree"] ?: 0) + buffers + cached + reclaimable)
        val swapTotal = values["SwapTotal"] ?: 0
        val swapFree = values["SwapFree"] ?: 0
        return MemorySnapshot(total, available, (total - available).coerceAtLeast(0), swapTotal, (swapTotal - swapFree).coerceAtLeast(0))
    }

    fun parseUptime(text: String): Double = text.trim().split(Regex("\\s+")).firstOrNull()?.toDoubleOrNull() ?: 0.0

    fun parseLoadAvg(text: String): List<Double> = text.trim().split(Regex("\\s+")).take(3).map { it.toDoubleOrNull() ?: 0.0 }

    fun parseNetDev(text: String): List<NetworkSnapshot> = text.lineSequence().mapNotNull { line ->
        val match = Regex("^\\s*([\\w.:-]+):\\s*(.*)$").find(line) ?: return@mapNotNull null
        val fields = match.groupValues[2].trim().split(Regex("\\s+")).mapNotNull { it.toLongOrNull() }
        if (fields.size < 9) return@mapNotNull null
        val iface = match.groupValues[1]
        if (iface.matches(Regex("(lo|docker\\d*|veth|br-|virbr|tun\\d*|tap\\d*).*"))) return@mapNotNull null
        NetworkSnapshot(iface, 0, 0, fields[0], fields[8])
    }.toList()

    fun parseDiskstats(text: String): List<DiskCounters> = text.lineSequence().mapNotNull { raw ->
        val f = raw.trim().split(Regex("\\s+"))
        if (f.size < 10 || !realDisk.matches(f[2])) return@mapNotNull null
        val read = f[5].toLongOrNull() ?: return@mapNotNull null
        val write = f[9].toLongOrNull() ?: return@mapNotNull null
        DiskCounters(f[2], read, write)
    }.toList()

    fun parseDf(text: String): List<FsUsage> = text.trim().lineSequence().drop(1).mapNotNull { raw ->
        val f = raw.trim().split(Regex("\\s+"))
        if (f.size < 6 || skipFs.matches(f[0])) return@mapNotNull null
        val total = f[1].toLongOrNull() ?: return@mapNotNull null
        val used = f[2].toLongOrNull() ?: return@mapNotNull null
        if (total <= 0) return@mapNotNull null
        FsUsage(f[0], f.drop(5).joinToString(" "), total, used, (used * 1000.0 / total).let { kotlin.math.round(it) / 10.0 })
    }.toList()

    fun parseTcpStates(text: String): Map<String, Int> {
        val names = mapOf("01" to "ESTABLISHED", "02" to "SYN_SENT", "03" to "SYN_RECV", "04" to "FIN_WAIT1", "05" to "FIN_WAIT2", "06" to "TIME_WAIT", "07" to "CLOSE", "08" to "CLOSE_WAIT", "09" to "LAST_ACK", "0A" to "LISTEN", "0B" to "CLOSING", "0C" to "NEW_SYN_RECV")
        val result = linkedMapOf<String, Int>()
        text.lineSequence().forEach { line ->
            val f = line.trim().split(Regex("\\s+"))
            if (f.size != 2 || !f[0].matches(Regex("[0-9A-Fa-f]{1,2}"))) return@forEach
            val count = f[1].toIntOrNull() ?: return@forEach
            val code = f[0].uppercase().padStart(2, '0')
            val name = names[code] ?: "UNKNOWN_$code"
            result[name] = (result[name] ?: 0) + count
        }
        return result
    }

    fun parsePsTop(text: String, limit: Int = 8): List<ProcInfo> = text.lineSequence().drop(1).mapNotNull { raw ->
        val f = raw.trim().split(Regex("\\s+"))
        if (f.size < 4) return@mapNotNull null
        val pid = f[0].toIntOrNull() ?: return@mapNotNull null
        val cpu = f[1].toDoubleOrNull() ?: return@mapNotNull null
        val mem = f[2].toDoubleOrNull() ?: 0.0
        ProcInfo(pid, f.drop(3).joinToString(" "), cpu, mem)
    }.take(limit).toList()

    fun parsePsAux(text: String, limit: Int = 8): List<ProcInfo> = text.lineSequence().mapNotNull { raw ->
        val f = raw.trim().split(Regex("\\s+"))
        if (f.size < 11) return@mapNotNull null
        val pid = f[1].toIntOrNull() ?: return@mapNotNull null
        val cpu = f[2].toDoubleOrNull() ?: return@mapNotNull null
        val mem = f[3].toDoubleOrNull() ?: 0.0
        ProcInfo(pid, f.drop(10).joinToString(" "), cpu, mem)
    }.sortedByDescending { it.cpuPct }.take(limit).toList()

    fun parseStatic(uname: String, hostname: String, nproc: String, osRelease: String, ipAddr: String): MonitorStaticInfo {
        val u = uname.trim().split(Regex("\\s+"))
        val distro = Regex("(?m)^(?:PRETTY_NAME|NAME)=\\\"?(.+?)\\\"?$").find(osRelease)?.groupValues?.get(1) ?: u.firstOrNull().orEmpty()
        val ips = Regex("inet\\s+(\\d+\\.\\d+\\.\\d+\\.\\d+)").findAll(ipAddr).map { it.groupValues[1] }.filter { it != "127.0.0.1" }.toList()
        return MonitorStaticInfo(hostname.trim(), u.getOrNull(1).orEmpty(), u.getOrNull(2).orEmpty(), distro, nproc.trim().toIntOrNull()?.coerceAtLeast(1) ?: 1, ips)
    }

    fun parseSockstat(text: String): ConnectionCounts? {
        var sockets = 0
        var tcp = 0
        var orphan = 0
        var tw = 0
        var udp = 0
        var hit = false
        text.lineSequence().forEach { raw ->
            val line = raw.trim()
            val match = Regex("^(sockets|TCP6?|UDP6?):\\s+(.*)$").find(line) ?: return@forEach
            val fields = match.groupValues[2].split(Regex("\\s+")).chunked(2).mapNotNull { pair ->
                if (pair.size == 2) pair[0] to pair[1].toIntOrNull() else null
            }.toMap()
            when (match.groupValues[1]) {
                "sockets" -> fields["used"]?.let { sockets += it; hit = true }
                "TCP", "TCP6" -> fields["inuse"]?.let { tcp += it; orphan += fields["orphan"] ?: 0; tw += fields["tw"] ?: 0; hit = true }
                "UDP", "UDP6" -> fields["inuse"]?.let { udp += it; hit = true }
            }
        }
        return if (hit) ConnectionCounts(sockets, tcp, orphan, tw, udp) else null
    }

    fun diffRate(previous: Long, current: Long, elapsedSeconds: Double): Long =
        if (elapsedSeconds <= 0 || current < previous) 0 else kotlin.math.round((current - previous) / elapsedSeconds).toLong()
}
