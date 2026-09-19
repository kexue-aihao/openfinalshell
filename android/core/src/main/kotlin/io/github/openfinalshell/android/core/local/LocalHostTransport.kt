package io.github.openfinalshell.android.core.local

import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.LOCAL_SHELL_PROTOCOL
import io.github.openfinalshell.android.core.model.SessionState
import io.github.openfinalshell.android.core.monitor.LocalCapabilities
import io.github.openfinalshell.android.core.monitor.LocalCapabilityProbe
import io.github.openfinalshell.android.core.monitor.LocalMonitorFrameSource
import io.github.openfinalshell.android.core.monitor.MonitorFrameSource
import io.github.openfinalshell.android.core.ssh.Credentials
import io.github.openfinalshell.android.core.ssh.ExecChannel
import io.github.openfinalshell.android.core.ssh.SftpChannel
import io.github.openfinalshell.android.core.ssh.ShellChannel
import io.github.openfinalshell.android.core.ssh.ShellCloseReason
import io.github.openfinalshell.android.core.ssh.ShellEvent
import io.github.openfinalshell.android.core.ssh.SshTransport
import io.github.openfinalshell.android.core.ssh.TransportEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * A local shell at a privileged tier, driven through a separately-started host process.
 *
 * This is the counterpart to the app-tier transport, and it exists because a PTY has to be created
 * inside a process that is *already* uid 2000 or 0: Termux's `TerminalSession` takes no uid, so
 * raising privilege cannot be done by asking for it. The host owns the PTY; this side owns the
 * protocol, and the two meet on loopback.
 *
 * Everything above this class is unchanged from the app tier — the terminal, the file panel and the
 * monitor all arrive here through the same [SshTransport] contract.
 */
class LocalHostTransport(
    private val launcher: HostLauncher,
    private val config: LocalHostConfig,
    private val scope: CoroutineScope
) : SshTransport {
    private val mutableState = MutableStateFlow(SessionState.CLOSED)
    override val state: StateFlow<SessionState> = mutableState.asStateFlow()

    private val mutableEvents = MutableSharedFlow<TransportEvent>(extraBufferCapacity = 4)
    override val events: Flow<TransportEvent> = mutableEvents.asSharedFlow()

    private var shell: LocalHostSession? = null
    private var capabilities: LocalCapabilities = LocalCapabilities.UNPROBED

    override val frameSource: MonitorFrameSource get() = LocalMonitorFrameSource(capabilities)

    override suspend fun connect(profile: ConnectionProfile, credentials: Credentials) {
        require(profile.protocol == LOCAL_SHELL_PROTOCOL) { "not a local session profile" }
        mutableState.value = SessionState.CONNECTING
        // Probing before declaring READY, because what a tier can collect is the tier's real value.
        // The probe runs through the same exec path the monitor will use, so it reports what the
        // monitor will really get rather than what the platform documentation claims.
        capabilities = probeCapabilities()
        mutableState.value = SessionState.READY
    }

    override suspend fun openShell(cols: Int, rows: Int): ShellChannel {
        shell?.let { existing ->
            if (!existing.exited.isCompleted) {
                existing.resize(rows, cols)
                return LocalHostShellChannel(existing)
            }
            shell = null
        }
        val session = start(command = null, cols = cols, rows = rows)
        shell = session
        scope.launch {
            // The shell exiting ends this local session: unlike SSH there is no connection to keep,
            // and reconnecting would respawn the shell forever the moment a user typed `exit`.
            runCatching { session.exited.await() }
            if (shell !== session) return@launch
            if (mutableState.value == SessionState.READY) {
                mutableState.value = SessionState.CLOSED
                mutableEvents.tryEmit(TransportEvent.Disconnected())
            }
        }
        return LocalHostShellChannel(session)
    }

    override suspend fun openExec(command: String): ExecChannel = LocalHostExecChannel(
        start(command = command, cols = DEFAULT_COLS, rows = DEFAULT_ROWS)
    )

    override suspend fun openSftp(): SftpChannel = LocalFileChannel(config.roots, config.mounts)

    override suspend fun disconnect() {
        val current = shell
        shell = null
        runCatching { current?.close() }
        runCatching { launcher.shutdown() }
        mutableState.value = SessionState.CLOSED
    }

    private suspend fun start(command: String?, cols: Int, rows: Int): LocalHostSession {
        val token = LocalHostCodec.newToken()
        val request = HostRequest(
            shellPath = config.shellPath,
            workingDirectory = config.workingDirectory,
            environment = config.environment,
            token = token,
            cols = cols,
            rows = rows,
            command = command
        )
        // On Dispatchers.IO regardless of how the launcher is written, because launching connects a
        // socket and the app calls this from the main dispatcher — a launcher that connected inline
        // would raise NetworkOnMainThreadException and every privileged session would fail to open.
        val session = LocalHostSession(withContext(Dispatchers.IO) { launcher.launch(request) }, scope)
        // A host that never answers must not leave a session half-open behind it.
        try {
            session.handshake(token)
        } catch (error: Throwable) {
            runCatching { session.close() }
            throw error
        }
        return session
    }

    private suspend fun probeCapabilities(): LocalCapabilities {
        var session: LocalHostSession? = null
        return try {
            session = start(command = LocalCapabilityProbe.probeCommand(), cols = DEFAULT_COLS, rows = DEFAULT_ROWS)
            val running = session
            // Bounded, because this runs inside connect(): a host that hangs must not hold the
            // session open forever. withTimeoutOrNull rethrows a real cancellation, unlike catching
            // the timeout type by hand.
            val text = withTimeoutOrNull(PROBE_TIMEOUT_MS) {
                buildString { running.output.collect { append(String(it, Charsets.UTF_8)) } }
            } ?: return LocalCapabilities.UNPROBED
            LocalCapabilityProbe.parse(text)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            // A probe failure must not cost the user their shell; the fallback is the conservative
            // subset that works at every tier.
            LocalCapabilities.UNPROBED
        } finally {
            // close() is cancellation-tolerant by construction, so cleanup still runs when the
            // caller's coroutine is being cancelled.
            runCatching { session?.close() }
        }
    }

    private companion object {
        const val DEFAULT_COLS = 80
        const val DEFAULT_ROWS = 24
        const val PROBE_TIMEOUT_MS = 10_000L
    }
}

/**
 * A privileged interactive shell.
 *
 * `ownsEmulator` is false: no emulator exists on this side, so the caller renders the bytes. That is
 * the opposite of the app tier, where Termux's session owns both the PTY and the emulator — and it
 * is why `ownsEmulator` is a property of the channel rather than of the profile.
 */
private class LocalHostShellChannel(private val session: LocalHostSession) : ShellChannel {
    override val ownsEmulator = false

    override val output: Flow<ByteArray> = session.output

    override val events: Flow<ShellEvent> = flow {
        runCatching { session.exited.await() }
        emit(ShellEvent.Closed(ShellCloseReason.CLOSED))
    }

    override suspend fun write(data: ByteArray) = session.sendInput(data)

    override suspend fun resize(cols: Int, rows: Int) = session.resize(rows, cols)

    override suspend fun close() = session.close()
}

/**
 * A one-shot privileged command.
 *
 * The exit status is recorded after the output stream ends rather than when it starts, because the
 * monitor reads it immediately after the collect returns and treats end-of-stream as end-of-command.
 */
private class LocalHostExecChannel(private val session: LocalHostSession) : ExecChannel {
    private val mutableExit = MutableStateFlow<Int?>(null)
    override val exitCode: StateFlow<Int?> = mutableExit.asStateFlow()

    override val output: Flow<ByteArray> = flow {
        try {
            session.output.collect { emit(it) }
        } finally {
            mutableExit.value = runCatching { session.exited.await() }.getOrDefault(-1)
            runCatching { session.close() }
        }
    }

    /** Safe to call before or after the output has been drained; the status is recorded either way. */
    override suspend fun close() {
        session.close()
        if (mutableExit.value == null) {
            mutableExit.value = runCatching { session.exited.await() }.getOrDefault(-1)
        }
    }
}
