package io.github.openfinalshell.android.core.monitor

import java.net.InetSocketAddress
import java.net.Socket
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Android-safe latency probes: TCP fallback is used when ICMP is unavailable. */
object LatencyProbe {
    suspend fun tcp(host: String, port: Int, timeoutMs: Int = 2000): Long? = withContext(Dispatchers.IO) {
        val started = System.nanoTime()
        try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), timeoutMs)
            }
            (System.nanoTime() - started) / 1_000_000
        } catch (_: Exception) {
            null
        }
    }
}
