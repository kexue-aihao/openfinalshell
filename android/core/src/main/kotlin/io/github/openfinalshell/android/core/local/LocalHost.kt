package io.github.openfinalshell.android.core.local

import kotlinx.coroutines.flow.Flow

/** A duplex byte carrier to a privileged host. TCP loopback today; nothing here assumes that. */
interface LocalHostStream {
    /**
     * Chunks as they arrive, until the host closes.
     *
     * Collect once. A cold implementation built on an input stream would misbehave if collected
     * twice, so the session treats this as single-shot.
     */
    fun incoming(): Flow<ByteArray>

    suspend fun send(bytes: ByteArray)

    suspend fun close()
}

/** Everything the host needs to start, plus the token the app will present. */
data class HostRequest(
    val shellPath: String,
    val workingDirectory: String,
    val environment: Array<String>,
    /** Lowercase hex, so it survives being passed through a shell argv. */
    val token: String,
    val cols: Int,
    val rows: Int,
    /** Null starts an interactive shell; a value runs it once, as `sh -c`. */
    val command: String? = null
)

/**
 * Starts a privileged PTY host.
 *
 * The seam exists so the protocol and the transport can be tested against the real helper without
 * any privilege at all — the tests supply a launcher that simply starts the helper as the app's own
 * uid. That leaves only the privilege escalation itself unverified rather than the whole tier.
 */
interface HostLauncher {
    /** True when this launcher's privilege is currently available on this device. */
    suspend fun isAvailable(): Boolean

    /** Starts a host and returns a connected, handshake-ready stream. */
    suspend fun launch(request: HostRequest): LocalHostStream

    /** Releases anything held across launches, such as a bound user service. */
    suspend fun shutdown()
}

/** What a privileged session needs in order to serve a shell, a file panel and a monitor. */
data class LocalHostConfig(
    val shellPath: String,
    val workingDirectory: String,
    val environment: Array<String>,
    val roots: LocalRoots,
    /**
     * Mount points the delete guard refuses at. Read from `/proc/self/mountinfo` by the app layer,
     * which is the only layer that can afford the read on every connect.
     */
    val mounts: Set<String> = emptySet()
)
