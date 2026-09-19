package io.github.openfinalshell.android.local

import io.github.openfinalshell.android.core.local.LocalHostArgs
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Reads the loopback port a freshly started host printed as its first stdout line.
 *
 * Shared by the Shizuku service and the `su` path so both agree on the contract. The read is on a
 * separate thread because it blocks: a host that died before printing would otherwise hold a Binder
 * thread, or the caller's, until the timeout.
 */
object LocalHostProcess {
    const val LAUNCH_TIMEOUT_MS = 8_000

    /** The bound port, or 0 when the host did not report one in time. */
    fun awaitPort(process: Process, timeoutMs: Int = LAUNCH_TIMEOUT_MS): Int {
        val firstLine = CompletableFuture<String>()
        Thread {
            runCatching { process.inputStream.bufferedReader().readLine().orEmpty() }
                .onSuccess { firstLine.complete(it) }
                .onFailure { firstLine.complete("") }
        }.apply { isDaemon = true }.start()
        val line = runCatching { firstLine.get(timeoutMs.toLong(), TimeUnit.MILLISECONDS) }.getOrDefault("")
        return LocalHostArgs.parsePort(line) ?: 0
    }
}
