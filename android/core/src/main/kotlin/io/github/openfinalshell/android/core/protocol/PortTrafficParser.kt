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
            PortTrafficEntry(port, connections, counters == connections, rxBps = rx, txBps = tx)
        }.toList()
        return PortTrafficSnapshot(timestamp, entries)
    }
}
