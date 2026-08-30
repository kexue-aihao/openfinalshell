package io.github.openfinalshell.android.core.monitor

import io.github.openfinalshell.android.core.model.ConnectionCounts
import io.github.openfinalshell.android.core.model.MemorySnapshot
import io.github.openfinalshell.android.core.model.NetworkSnapshot

data class CpuTimes(val total: Long, val idle: Long)

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
