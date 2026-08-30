package io.github.openfinalshell.android.core.ssh

import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.SessionState
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Owns session lifecycle and preserves the desktop reconnect semantics without UI dependencies. */
class SshSessionManager(
    private val transportFactory: () -> SshTransport,
    private val scope: CoroutineScope
) {
    private val mutableState = MutableStateFlow(SessionState.CLOSED)
    val state: StateFlow<SessionState> = mutableState
    private var transport: SshTransport? = null
    private var reconnectJob: Job? = null
    private var lastProfile: ConnectionProfile? = null
    private var lastCredentials: Credentials? = null

    suspend fun connect(profile: ConnectionProfile, credentials: Credentials) {
        reconnectJob?.cancel()
        lastProfile = profile
        lastCredentials = credentials
        val next = transport ?: transportFactory().also { transport = it }
        next.connect(profile, credentials)
        mutableState.value = SessionState.READY
    }

    fun scheduleReconnect() {
        val profile = lastProfile ?: return
        val credentials = lastCredentials ?: return
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            mutableState.value = SessionState.RECONNECTING
            var delayMs = 1_000L
            repeat(10) {
                try {
                    connect(profile, credentials)
                    return@launch
                } catch (_: Throwable) {
                    delay(delayMs)
                    delayMs = min(delayMs * 2, 30_000L)
                }
            }
            mutableState.value = SessionState.CLOSED
        }
    }

    suspend fun openShell(cols: Int, rows: Int): ShellChannel =
        checkNotNull(transport) { "SSH session is not connected" }.openShell(cols, rows)

    suspend fun openSftp(): SftpChannel =
        checkNotNull(transport) { "SSH session is not connected" }.openSftp()

    suspend fun disconnect() {
        reconnectJob?.cancel()
        transport?.disconnect()
        transport = null
        mutableState.value = SessionState.CLOSED
    }
}
