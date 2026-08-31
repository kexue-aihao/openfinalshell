package io.github.openfinalshell.android.core.monitor

import java.net.InetSocketAddress
import java.net.Socket
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Android-safe latency probes: TCP fallback is used when ICMP is unavailable. */
object LatencyProbe {
    suspend fun measure(host: String, port: Int, timeoutMs: Int = 2000): Long? = withContext(Dispatchers.IO) {
        val started = System.nanoTime()
        try {
            if (InetSocketAddress(host, port).address?.isReachable(timeoutMs) == true) {
                return@withContext (System.nanoTime() - started) / 1_000_000
            }
        } catch (_: Exception) {
            // ICMP is unavailable on many Android builds; use TCP below.
        }
        tcpBlocking(host, port, timeoutMs)
    }

    suspend fun tcp(host: String, port: Int, timeoutMs: Int = 2000): Long? = withContext(Dispatchers.IO) {
        tcpBlocking(host, port, timeoutMs)
    }

    private fun tcpBlocking(host: String, port: Int, timeoutMs: Int): Long? {
        val started = System.nanoTime()
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), timeoutMs)
            }
            (System.nanoTime() - started) / 1_000_000
        } catch (_: Exception) {
            null
        }
    }
}
