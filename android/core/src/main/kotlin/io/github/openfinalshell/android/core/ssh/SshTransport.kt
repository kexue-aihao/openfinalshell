package io.github.openfinalshell.android.core.ssh

import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.ForwardRule
import io.github.openfinalshell.android.core.model.SessionState
import io.github.openfinalshell.android.core.monitor.MonitorFrameSource
import java.security.PublicKey
import java.security.MessageDigest
import java.util.Base64
import org.apache.sshd.common.util.buffer.ByteArrayBuffer
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow

interface SshTransport {
    val state: StateFlow<SessionState>
    /** Lifecycle events from the underlying SSH client. */
    val events: Flow<TransportEvent>
        get() = emptyFlow()

    /**
     * What this transport's shell can answer for the monitoring panel, or null to use the remote
     * Linux frame.
     *
     * It belongs here because "which of these commands works" is a property of the shell on the far
     * end — a plain Linux box answers all of them, an Android device answers a tier-dependent
     * subset — and the transport is what knows.
     */
    val frameSource: MonitorFrameSource?
        get() = null

    suspend fun connect(profile: ConnectionProfile, credentials: Credentials)
    suspend fun openShell(cols: Int, rows: Int): ShellChannel
    /** Opens a one-shot command channel. The channel completes when the remote command exits. */
    suspend fun openExec(command: String): ExecChannel
    suspend fun openSftp(): SftpChannel
    /** Starts a standard SSH port-forwarding tracker owned by this session. */
    suspend fun startForwarding(rule: ForwardRule): AutoCloseable {
        error("SSH port forwarding is not supported by this transport")
    }
    suspend fun disconnect()
}

sealed interface TransportEvent {
    data class Disconnected(val cause: Throwable? = null) : TransportEvent
}

/** Resolves references held by a profile into one-shot connection credentials. */
fun interface CredentialsResolver {
    suspend fun resolve(profile: ConnectionProfile, supplied: Credentials): Credentials
}

/** App-owned host key policy. The callback may suspend while a Compose prompt is visible. */
fun interface HostKeyVerifier {
    suspend fun verify(host: String, port: Int, key: PublicKey): Boolean
}

data class Credentials(
    val password: CharArray? = null,
    val privateKey: ByteArray? = null,
    val passphrase: CharArray? = null
) {
    fun wipe() {
        password?.fill('\u0000')
        privateKey?.fill(0)
        passphrase?.fill('\u0000')
    }
}

object PassthroughCredentialsResolver : CredentialsResolver {
    override suspend fun resolve(profile: ConnectionProfile, supplied: Credentials): Credentials = supplied
}

object HostKeyFingerprint {
    fun keyType(key: PublicKey): String = org.apache.sshd.common.config.keys.KeyUtils.getKeyType(key)
    fun sha256(key: PublicKey): String {
        val blob = ByteArrayBuffer().apply { putPublicKey(key) }.compactData
        return Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(blob)).trimEnd('=')
    }
}

interface ShellChannel {
    /**
     * True when the backend already feeds a terminal emulator, so its output must not be rendered
     * a second time. A local on-device shell backed by Termux's TerminalSession owns both the PTY
     * and the emulator; every SSH and socket-backed channel leaves this false. Callers must branch
     * on this rather than on the profile protocol, because the privileged local tiers are plain
     * PTYs over a socket and do not own an emulator.
     */
    val ownsEmulator: Boolean get() = false
    val output: Flow<ByteArray>
    val events: Flow<ShellEvent>
        get() = emptyFlow()
    suspend fun write(data: ByteArray)
    suspend fun resize(cols: Int, rows: Int)
    suspend fun close()
}

interface ExecChannel {
    val output: Flow<ByteArray>
    val exitCode: StateFlow<Int?>
    suspend fun close()
}

sealed interface ShellEvent {
    data class Closed(val reason: ShellCloseReason) : ShellEvent
}

enum class ShellCloseReason { CLOSED, ERROR }

interface SftpChannel {
    suspend fun list(path: String): List<SftpEntry>
    suspend fun read(path: String): ByteArray
    /** Reads at most maxBytes from a remote offset; transports may use a buffered fallback. */
    suspend fun readChunk(path: String, offset: Long, maxBytes: Int): ByteArray {
        val all = read(path)
        if (offset >= all.size) return ByteArray(0)
        return all.copyOfRange(offset.toInt(), minOf(offset + maxBytes, all.size.toLong()).toInt())
    }
    suspend fun write(path: String, data: ByteArray)
    suspend fun mkdir(path: String) { error("mkdir is not supported by this transport") }
    suspend fun rename(from: String, to: String) { error("rename is not supported by this transport") }
    suspend fun atomicReplace(from: String, to: String) { throw AtomicReplaceUnavailable() }
    suspend fun permissions(path: String, mode: Int) { error("permissions are not supported by this transport") }
    suspend fun writeChunk(path: String, data: ByteArray, offset: Long, truncate: Boolean = false) {
        require(offset == 0L) { "the transport does not support ranged writes" }
        write(path, data)
    }
    suspend fun delete(path: String, recursive: Boolean = false)
    suspend fun close()
}

class AtomicReplaceUnavailable : IllegalStateException("atomic replacement is unavailable")

data class SftpEntry(val name: String, val path: String, val type: Type, val size: Long? = null, val permissions: Int? = null) {
    enum class Type { FILE, DIRECTORY, SYMLINK, OTHER }
}
