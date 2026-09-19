package io.github.openfinalshell.android.local

import android.util.Log
import io.github.openfinalshell.android.core.local.LocalFileChannel
import io.github.openfinalshell.android.core.local.LocalRoots
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
import io.github.openfinalshell.android.core.ssh.SshTransport
import io.github.openfinalshell.android.core.ssh.TransportEvent
import io.github.openfinalshell.android.terminal.LocalTerminalController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * A shell that runs on this device, presented through the same [SshTransport] contract as a remote
 * server.
 *
 * That reuse is the whole point: registering this in
 * [SshSessionManager][io.github.openfinalshell.android.core.ssh.SshSessionManager] is what gives the
 * terminal, the file panel, the monitoring panel and the AI assistant a local session without any
 * of them learning that a local session exists.
 *
 * This is the app tier — the shell runs as the app's own uid. It needs no setup and cannot be
 * refused, and it also cannot see `/sdcard` unless the user grants all-files access. The privileged
 * tiers replace only the way the PTY is created; everything above this class is unchanged.
 */
class LocalShellTransport(
    private val spec: LocalShellSpec,
    private val roots: LocalRoots,
    private val scope: CoroutineScope
) : SshTransport {
    private val mutableState = MutableStateFlow(SessionState.CLOSED)
    override val state: StateFlow<SessionState> = mutableState.asStateFlow()

    private val mutableEvents = MutableSharedFlow<TransportEvent>(extraBufferCapacity = 4)
    override val events: Flow<TransportEvent> = mutableEvents.asSharedFlow()

    @Volatile private var controller: LocalTerminalController? = null
    @Volatile private var closing = false
    private var mounts: Set<String> = emptySet()
    private var capabilities: LocalCapabilities = LocalCapabilities.UNPROBED

    /** The uid the shell actually runs as, or -1 before the probe. */
    val probedUid: Int get() = capabilities.uid

    override val frameSource: MonitorFrameSource get() = LocalMonitorFrameSource(capabilities)

    override suspend fun connect(profile: ConnectionProfile, credentials: Credentials) {
        require(profile.protocol == LOCAL_SHELL_PROTOCOL) { "not a local session profile" }
        closing = false
        spec.prepareDirectories()
        mounts = withContext(Dispatchers.IO) { LocalMounts.read() }
        capabilities = probeCapabilities()
        mutableState.value = SessionState.READY
    }

    override suspend fun openShell(cols: Int, rows: Int): ShellChannel {
        controller?.let { existing ->
            if (!existing.finished.isCompleted) {
                existing.resize(cols, rows)
                return LocalShellChannel(existing)
            }
            controller = null
        }
        // The controller dispatches itself to the main thread, because TerminalSession needs a
        // Looper to build its callback Handler. See LocalTerminalController.start.
        val started = LocalTerminalController.start(
            shellPath = spec.shellPath,
            cwd = spec.workingDirectory,
            // argv[0] must be supplied by the caller: the native side calls execvp(cmd, argv) and
            // never prepends the command to argv itself.
            args = arrayOf(spec.shellPath),
            env = spec.environment,
            transcriptRows = spec.transcriptRows,
            cols = cols,
            rows = rows
        )
        controller = started
        scope.launch {
            started.finished.await()
            if (closing) return@launch
            // The shell exited, so this local session is over: unlike SSH there is no connection
            // left to keep. Reporting a disconnect rather than reconnecting is what stops `exit`
            // from respawning the shell forever, which is also why local profiles are created with
            // autoReconnect disabled.
            mutableState.value = SessionState.CLOSED
            mutableEvents.tryEmit(TransportEvent.Disconnected())
        }
        return LocalShellChannel(started)
    }

    override suspend fun openExec(command: String): ExecChannel = withContext(Dispatchers.IO) {
        LocalExecChannel.start(spec.shellPath, command, spec.workingDirectory, spec.environment)
    }

    override suspend fun openSftp(): SftpChannel = LocalFileChannel(roots, mounts)

    override suspend fun disconnect() {
        closing = true
        controller?.let { runCatching { it.closeSession() } }
        controller = null
        mutableState.value = SessionState.CLOSED
    }

    /**
     * Runs the capability probe through the same exec path the monitor uses, so what it reports is
     * what the monitor will really get rather than what the platform documentation claims.
     *
     * Bounded, because it runs inside `connect()`: one applet that waits on input would otherwise
     * hold the whole session at CONNECTING with no way out. The channel is closed even on timeout so
     * the probe process does not outlive its answer.
     */
    private suspend fun probeCapabilities(): LocalCapabilities {
        var channel: LocalExecChannel? = null
        return try {
            channel = withContext(Dispatchers.IO) {
                LocalExecChannel.start(spec.shellPath, LocalCapabilityProbe.probeCommand(), spec.workingDirectory, spec.environment)
            }
            val running = channel
            val text = withTimeoutOrNull(PROBE_TIMEOUT_MS) {
                buildString { running.output.collect { append(String(it, Charsets.UTF_8)) } }
            } ?: return LocalCapabilities.UNPROBED.also {
                Log.w(TAG, "local capability probe timed out after ${PROBE_TIMEOUT_MS}ms; using the conservative default")
            }
            LocalCapabilityProbe.parse(text)
        } catch (error: Throwable) {
            // A probe failure must not cost the user their shell: the fallback set is the
            // conservative subset an app-uid shell manages on every supported release.
            Log.w(TAG, "local capability probe failed; using the conservative default", error)
            LocalCapabilities.UNPROBED
        } finally {
            runCatching { channel?.close() }
        }
    }

    private companion object {
        const val TAG = "LocalShellTransport"
        const val PROBE_TIMEOUT_MS = 5_000L
    }
}
