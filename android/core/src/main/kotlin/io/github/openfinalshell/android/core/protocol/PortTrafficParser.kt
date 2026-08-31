package io.github.openfinalshell.android.core.protocol

import io.github.openfinalshell.android.core.model.PortTrafficEntry
import io.github.openfinalshell.android.core.model.PortTrafficSnapshot

/** Parses the compact `port connections rx tx counterConnections` output from portTrafficScript.ts. */
object PortTrafficParser {
    fun parse(text: String, timestamp: Long = System.currentTimeMillis()): PortTrafficSnapshot? {
        if (text.lineSequence().any { it.trim() == "@@OFS:NOSS@@" }) return null
        val entries = text.lineSequence().mapNotNull { raw ->
            val fields = raw.trim().split(Regex("\\s+"))
            if (fields.size < 5) return@mapNotNull null
            val port = fields[0].toIntOrNull() ?: return@mapNotNull null
            val connections = fields[1].toIntOrNull() ?: return@mapNotNull null
            val rx = fields[2].toLongOrNull() ?: return@mapNotNull null
            val tx = fields[3].toLongOrNull() ?: return@mapNotNull null
            val counters = fields[4].toIntOrNull() ?: 0
            if (port !in 1..65535 || connections < 0 || rx < 0 || tx < 0) return@mapNotNull null
            PortTrafficEntry(port, connections, counters == connections, rxBps = rx, txBps = tx, rxTotalBytes = rx, txTotalBytes = tx)
        }.toList()
        return PortTrafficSnapshot(timestamp, entries)
    }
}

/** Converts cumulative TCP_INFO counters into per-second rates between samples. */
class PortTrafficRateTracker {
    private data class Previous(val at: Long, val rx: Long, val tx: Long)
    private val previous = mutableMapOf<Int, Previous>()

    fun apply(snapshot: PortTrafficSnapshot): PortTrafficSnapshot {
        val next = mutableMapOf<Int, Previous>()
        val entries = snapshot.ports.map { entry ->
            val old = previous[entry.port]
            val elapsed = old?.let { (snapshot.ts - it.at).coerceAtLeast(1L).toDouble() / 1000.0 }
            val available = entry.ratesAvailable && old != null && elapsed != null && entry.rxTotalBytes >= old.rx && entry.txTotalBytes >= old.tx
            val rx = if (available) kotlin.math.round((entry.rxTotalBytes - old!!.rx) / elapsed!!).toLong() else 0L
            val tx = if (available) kotlin.math.round((entry.txTotalBytes - old!!.tx) / elapsed!!).toLong() else 0L
            next[entry.port] = Previous(snapshot.ts, entry.rxTotalBytes, entry.txTotalBytes)
            entry.copy(ratesAvailable = available, rxBps = rx, txBps = tx)
        }
        previous.clear()
        previous.putAll(next)
        return snapshot.copy(ports = entries)
    }
}
