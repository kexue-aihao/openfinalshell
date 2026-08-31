package io.github.openfinalshell.android.core.ssh

import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.ForwardRule
import io.github.openfinalshell.android.core.model.SessionState
import java.util.UUID
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

data class SessionSnapshot(
    val sessionId: String,
    val profile: ConnectionProfile,
    val state: SessionState,
    val error: String? = null,
    val shellCount: Int = 0
)

sealed interface SessionEvent {
    data class StateChanged(
        val sessionId: String,
        val state: SessionState,
        val error: String? = null
    ) : SessionEvent

    data class ShellOpened(val sessionId: String, val shell: ShellChannel) : SessionEvent

    data class ShellClosed(
        val sessionId: String,
        val reason: ShellCloseReason
    ) : SessionEvent

    data class Reconnected(val sessionId: String) : SessionEvent
}

/**
 * Owns all runtime SSH sessions. The registry is independent of Compose so a screen change
 * cannot accidentally close another connection. A profile may have several live sessions.
 */
class SshSessionManager(
    private val transportFactory: () -> SshTransport,
    private val scope: CoroutineScope,
    private val credentialsResolver: CredentialsResolver = PassthroughCredentialsResolver,
    private val shouldReconnect: (ConnectionProfile) -> Boolean = { true }
) {
    private data class Entry(
        val sessionId: String,
        val profile: ConnectionProfile,
        var transport: SshTransport,
        var credentials: Credentials? = null,
        var state: SessionState = SessionState.CONNECTING,
        var error: String? = null,
        var intentionalClose: Boolean = false,
        var reconnectJob: Job? = null,
        val shellJobs: MutableMap<ShellChannel, Job> = linkedMapOf(),
        var transportStateJob: Job? = null,
        var transportEventJob: Job? = null
    )

    private val lock = Any()
    private val entries = linkedMapOf<String, Entry>()
    private val mutableSnapshots = MutableStateFlow<Map<String, SessionSnapshot>>(emptyMap())
    val sessions: StateFlow<Map<String, SessionSnapshot>> = mutableSnapshots.asStateFlow()

    private val mutableEvents = MutableSharedFlow<SessionEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<SessionEvent> = mutableEvents.asSharedFlow()

    private val mutableState = MutableStateFlow(SessionState.CLOSED)
    val state: StateFlow<SessionState> = mutableState.asStateFlow()

    private val mutableActiveSessionId = MutableStateFlow<String?>(null)
    val activeSessionId: StateFlow<String?> = mutableActiveSessionId.asStateFlow()

    /** Opens a new runtime session and returns its stable id. */
    suspend fun connect(profile: ConnectionProfile, supplied: Credentials): String {
        val entry = Entry(UUID.randomUUID().toString(), profile, transportFactory())
        synchronized(lock) {
            entries[entry.sessionId] = entry
            mutableActiveSessionId.value = entry.sessionId
            publishSnapshotLocked(entry)
        }
        attachTransport(entry)
        try {
            updateState(entry, SessionState.CONNECTING, null)
            val resolved = credentialsResolver.resolve(profile, supplied)
            val sessionCredentials = resolved.copyForSession()
            entry.credentials = sessionCredentials
            updateState(entry, SessionState.AUTHENTICATING, null)
            entry.transport.connect(profile, sessionCredentials)
            if (resolved !== supplied) resolved.wipe()
            updateState(entry, SessionState.READY, null)
            return entry.sessionId
        } catch (error: Throwable) {
            entry.credentials?.wipe()
            entry.credentials = null
            updateState(entry, SessionState.CLOSED, error.message ?: "Connection failed")
            detachTransport(entry)
            throw error
        }
    }

    /** Selects an existing session for UI operations without opening another SSH connection. */
    fun select(sessionId: String?) {
        val selected = sessionId?.takeIf { synchronized(lock) { entries.containsKey(it) } }
        mutableActiveSessionId.value = selected
        val selectedState = selected?.let { synchronized(lock) { entries[it]?.state } }
        mutableState.value = selectedState ?: SessionState.CLOSED
    }

    /** Returns the current runtime state without exposing mutable session entries. */
    fun sessionState(sessionId: String): SessionState? =
        synchronized(lock) { entries[sessionId]?.state }

    suspend fun openShell(sessionId: String, cols: Int, rows: Int): ShellChannel {
        val entry = requireEntry(sessionId)
        check(entry.state == SessionState.READY) { "SSH session is not connected" }
        val shell = entry.transport.openShell(cols, rows)
        val job = scope.launch {
            shell.events.collect { event ->
                if (event is ShellEvent.Closed) {
                    synchronized(lock) { entry.shellJobs.remove(shell) }
                    updateShellCount(entry)
                    mutableEvents.tryEmit(SessionEvent.ShellClosed(sessionId, event.reason))
                }
            }
        }
        synchronized(lock) { entry.shellJobs[shell] = job }
        updateShellCount(entry)
        mutableEvents.tryEmit(SessionEvent.ShellOpened(sessionId, shell))
        return shell
    }

    /** Backwards-compatible entry point for the original single-session caller. */
    suspend fun openShell(cols: Int, rows: Int): ShellChannel =
        openShell(requireActiveSession().sessionId, cols, rows)

    suspend fun openSftp(sessionId: String): SftpChannel {
        val entry = requireEntry(sessionId)
        check(entry.state == SessionState.READY) { "SSH session is not connected" }
        return entry.transport.openSftp()
    }

    suspend fun openSftp(): SftpChannel = openSftp(requireActiveSession().sessionId)

    /** Starts forwarding through the selected SSH session and returns its close handle. */
    suspend fun startForwarding(sessionId: String, rule: ForwardRule): AutoCloseable {
        val entry = requireEntry(sessionId)
        check(entry.state == SessionState.READY) { "SSH session is not connected" }
        return entry.transport.startForwarding(rule)
    }

    suspend fun openExec(sessionId: String, command: String): ExecChannel {
        val entry = requireEntry(sessionId)
        check(entry.state == SessionState.READY) { "SSH session is not connected" }
        return entry.transport.openExec(command)
    }

    suspend fun openExec(command: String): ExecChannel = openExec(requireActiveSession().sessionId, command)

    suspend fun reconnect(sessionId: String) {
        val entry = requireEntry(sessionId)
        entry.intentionalClose = false
        entry.reconnectJob?.cancel()
        entry.reconnectJob = null
        reconnectNow(entry, emitReconnected = true)
    }

    /** Schedules automatic reconnect for the active session. */
    fun scheduleReconnect() {
        val entry = mutableActiveSessionId.value?.let { synchronized(lock) { entries[it] } } ?: return
        scheduleReconnect(entry)
    }

    suspend fun disconnect(sessionId: String) {
        val entry = synchronized(lock) { entries[sessionId] } ?: return
        entry.intentionalClose = true
        entry.reconnectJob?.cancel()
        entry.reconnectJob = null
        closeShells(entry)
        detachTransport(entry)
        entry.transport.disconnect()
        entry.credentials?.wipe()
        entry.credentials = null
        updateState(entry, SessionState.CLOSED, null)
        if (mutableActiveSessionId.value == sessionId) mutableActiveSessionId.value = null
    }

    suspend fun disconnect() {
        val ids = synchronized(lock) { entries.keys.toList() }
        ids.forEach { disconnect(it) }
    }

    fun close(sessionId: String) {
        scope.launch { disconnect(sessionId) }
    }

    private fun attachTransport(entry: Entry) {
        entry.transportStateJob = scope.launch {
            entry.transport.state.collect { state ->
                if (!entry.intentionalClose) updateState(entry, state, entry.error)
            }
        }
        entry.transportEventJob = scope.launch {
            entry.transport.events.collect { event ->
                if (event is TransportEvent.Disconnected && !entry.intentionalClose) {
                    handleUnexpectedDisconnect(entry, event.cause)
                }
            }
        }
    }

    private fun detachTransport(entry: Entry) {
        entry.transportStateJob?.cancel()
        entry.transportEventJob?.cancel()
        entry.transportStateJob = null
        entry.transportEventJob = null
    }

    private fun handleUnexpectedDisconnect(entry: Entry, cause: Throwable?) {
        if (entry.intentionalClose || !shouldReconnect(entry.profile)) {
            updateState(entry, SessionState.CLOSED, cause?.message)
            return
        }
        closeShells(entry)
        updateState(entry, SessionState.RECONNECTING, cause?.message)
        scheduleReconnect(entry)
    }

    private fun scheduleReconnect(entry: Entry) {
        synchronized(lock) {
            if (entry.reconnectJob?.isActive == true || entry.intentionalClose) return
            entry.reconnectJob = scope.launch {
                var delayMs = 1_000L
                repeat(10) { attempt ->
                    if (entry.intentionalClose) return@launch
                    try {
                        delay(delayMs)
                        reconnectNow(entry, emitReconnected = true)
                        return@launch
                    } catch (error: Throwable) {
                        updateState(entry, SessionState.RECONNECTING, error.message)
                        if (attempt == 9) {
                            updateState(entry, SessionState.CLOSED, error.message ?: "Reconnect failed")
                        }
                        delayMs = min(delayMs * 2, 30_000L)
                    }
                }
            }
        }
    }

    private suspend fun reconnectNow(entry: Entry, emitReconnected: Boolean) {
        updateState(entry, SessionState.RECONNECTING, null)
        detachTransport(entry)
        runCatching { entry.transport.disconnect() }
        entry.transport = transportFactory()
        attachTransport(entry)
        val credentials = entry.credentials?.copyForUse() ?: Credentials()
        try {
            updateState(entry, SessionState.AUTHENTICATING, null)
            entry.transport.connect(entry.profile, credentials)
            updateState(entry, SessionState.READY, null)
            if (emitReconnected) mutableEvents.tryEmit(SessionEvent.Reconnected(entry.sessionId))
        } finally {
            credentials.wipe()
        }
    }

    private fun closeShells(entry: Entry) {
        val shells = synchronized(lock) {
            val result = entry.shellJobs.keys.toList()
            entry.shellJobs.values.forEach { it.cancel() }
            entry.shellJobs.clear()
            result
        }
        shells.forEach { shell ->
            mutableEvents.tryEmit(SessionEvent.ShellClosed(entry.sessionId, ShellCloseReason.CLOSED))
            scope.launch { runCatching { shell.close() } }
        }
        updateShellCount(entry)
    }

    private fun updateState(entry: Entry, state: SessionState, error: String?) {
        synchronized(lock) {
            if (!entries.containsKey(entry.sessionId)) return
            entry.state = state
            entry.error = error
            publishSnapshotLocked(entry)
        }
        if (mutableActiveSessionId.value == entry.sessionId) mutableState.value = state
        mutableEvents.tryEmit(SessionEvent.StateChanged(entry.sessionId, state, error))
    }

    private fun updateShellCount(entry: Entry) {
        synchronized(lock) { publishSnapshotLocked(entry) }
    }

    private fun publishSnapshotLocked(entry: Entry) {
        val current = mutableSnapshots.value.toMutableMap()
        current[entry.sessionId] = SessionSnapshot(
            sessionId = entry.sessionId,
            profile = entry.profile,
            state = entry.state,
            error = entry.error,
            shellCount = entry.shellJobs.size
        )
        mutableSnapshots.value = current.toMap()
    }

    private fun requireEntry(sessionId: String): Entry =
        synchronized(lock) { entries[sessionId] } ?: error("SSH session not found")

    private fun requireActiveSession(): Entry =
        mutableActiveSessionId.value?.let(::requireEntry) ?: error("SSH session is not selected")

    private fun Credentials.copyForSession(): Credentials =
        Credentials(password?.copyOf(), privateKey?.copyOf(), passphrase?.copyOf())

    private fun Credentials.copyForUse(): Credentials = copyForSession()
}
