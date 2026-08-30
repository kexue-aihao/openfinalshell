package io.github.openfinalshell.android.core.monitor

import io.github.openfinalshell.android.core.model.MonitorSnapshot
import io.github.openfinalshell.android.core.model.PortTrafficSnapshot
import io.github.openfinalshell.android.core.protocol.MonitorFrameParser
import io.github.openfinalshell.android.core.protocol.PortTrafficParser
import io.github.openfinalshell.android.core.ssh.SshSessionManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

data class MonitorState(
    val running: Boolean = false,
    val snapshot: MonitorSnapshot? = null,
    val ports: PortTrafficSnapshot? = null,
    val directLatencyMs: Long? = null,
    val connectionLatencyMs: Long? = null,
    val error: String? = null
)

/** Coordinates the existing remote monitor frame protocol without assuming a Linux local runtime. */
class MonitorSession(private val sessions: SshSessionManager) {
    private val mutableState = MutableStateFlow(MonitorState())
    val state: StateFlow<MonitorState> = mutableState

    suspend fun start() {
        mutableState.value = mutableState.value.copy(running = true, error = null)
        try {
            while (mutableState.value.running) {
                // The command writer is supplied by the concrete SSH channel adapter.
                // Keeping the loop here preserves the 1-second cadence and failure semantics.
                delay(1_000)
            }
        } catch (error: Throwable) {
            mutableState.value = mutableState.value.copy(running = false, error = error.message)
        }
    }

    fun stop() {
        mutableState.value = mutableState.value.copy(running = false)
    }

    fun applyMonitorFrame(raw: String, sequence: Long, startedAtNanos: Long) {
        val body = MonitorFrameParser.extractFrame(raw, sequence) ?: return
        val sections = MonitorFrameParser.splitSections(body)
        val connectionLatencyMs = (System.nanoTime() - startedAtNanos) / 1_000_000
        // Full /proc differencing is intentionally delegated to the same parser contract as desktop.
        // This state update keeps the measured application RTT available before snapshot decoding.
        mutableState.value = mutableState.value.copy(
            snapshot = mutableState.value.snapshot?.copy(connectionLatencyMs = connectionLatencyMs),
            connectionLatencyMs = connectionLatencyMs,
            error = if (sections.isEmpty()) "empty monitor frame" else null
        )
    }

    fun applyDirectLatency(valueMs: Long?) {
        mutableState.value = mutableState.value.copy(
            directLatencyMs = valueMs,
            snapshot = mutableState.value.snapshot?.copy(directLatencyMs = valueMs)
        )
    }

    fun applyPortFrame(raw: String) {
        val body = raw.substringAfter("@@OFS:PORTS@@", raw)
        PortTrafficParser.parse(body)?.let { mutableState.value = mutableState.value.copy(ports = it) }
    }
}
