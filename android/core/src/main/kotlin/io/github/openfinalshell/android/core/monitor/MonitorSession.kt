package io.github.openfinalshell.android.core.monitor

import io.github.openfinalshell.android.core.model.CpuSnapshot
import io.github.openfinalshell.android.core.model.DiskFsSnapshot
import io.github.openfinalshell.android.core.model.DiskIoSnapshot
import io.github.openfinalshell.android.core.model.MemorySnapshot
import io.github.openfinalshell.android.core.model.MonitorSnapshot
import io.github.openfinalshell.android.core.model.MonitorStaticInfo
import io.github.openfinalshell.android.core.model.NetworkSnapshot
import io.github.openfinalshell.android.core.model.PortTrafficSnapshot
import io.github.openfinalshell.android.core.model.ProcessSnapshot
import io.github.openfinalshell.android.core.protocol.MonitorFrameParser
import io.github.openfinalshell.android.core.protocol.PortTrafficParser
import io.github.openfinalshell.android.core.protocol.PortTrafficRateTracker
import io.github.openfinalshell.android.core.ssh.SshSessionManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.withContext

/**
 * Which metrics the current session can actually produce.
 *
 * This exists so a source that cannot answer a section reads as "unavailable at this tier" rather
 * than as a real zero. An app-uid shell denied `/proc/meminfo` used to render as `0 B / 0 B`, which
 * is a statement about the device rather than about the limitation.
 */
data class MonitorAvailability(
    val memory: Boolean = true,
    val disk: Boolean = true,
    val processes: Boolean = true,
    val tcpStates: Boolean = true,
    val portTraffic: Boolean = true
)

data class MonitorState(
    val running: Boolean = false,
    val snapshot: MonitorSnapshot? = null,
    val staticInfo: MonitorStaticInfo? = null,
    val ports: PortTrafficSnapshot? = null,
    val directLatencyMs: Long? = null,
    val connectionLatencyMs: Long? = null,
    val available: MonitorAvailability = MonitorAvailability(),
    val error: String? = null
)

/**
 * Executes and decodes the same sentinel-delimited monitor frames as the desktop client.
 *
 * The frame *source* is per session, because a remote Linux server and a local Android shell answer
 * different subsets of the same frame. Collection and parsing stay shared, so SSH monitoring is
 * unaffected; see [MonitorFrameSource].
 *
 * Delta state is per session. It used to be single unkeyed fields, which meant two sessions
 * monitored in turn diffed one host's CPU counters against the other's and reported a rate that
 * described neither.
 */
class MonitorSession(
    private val sessions: SshSessionManager,
    /** Resolves a session's frame source; null falls back to the remote Linux frame. */
    private val frameSourceFor: (String) -> MonitorFrameSource? = { null }
) {
    private val mutableState = MutableStateFlow(MonitorState())
    val state: StateFlow<MonitorState> = mutableState
    private val portRates = PortTrafficRateTracker()
    private val deltas = mutableMapOf<String, MonitorDelta>()

    private class MonitorDelta {
        var cpu: CpuTimes? = null
        var cores: List<CpuTimes> = emptyList()
        var net: Map<String, Pair<Long, Long>> = emptyMap()
        var disk: Map<String, Pair<Long, Long>> = emptyMap()
        var sequence = 0L

        /** Per session, not read from the shared snapshot: two sessions monitored in turn would
         *  otherwise measure one host's byte counters over the other's elapsed time. */
        var lastSampleAtMs: Long? = null
    }

    private fun source(sessionId: String): MonitorFrameSource =
        frameSourceFor(sessionId) ?: LinuxMonitorFrameSource

    private fun deltaFor(sessionId: String): MonitorDelta = deltas.getOrPut(sessionId) { MonitorDelta() }

    fun reset() {
        deltas.clear()
        mutableState.value = MonitorState()
    }

    /** Drops one session's counters, for when its shell is replaced rather than continued. */
    fun reset(sessionId: String) {
        deltas.remove(sessionId)
    }

    suspend fun start(intervalSeconds: Int = 2) {
        val sessionId = sessions.activeSessionId.value ?: error("SSH session is not selected")
        start(sessionId, intervalSeconds)
    }

    suspend fun start(sessionId: String, intervalSeconds: Int = 2) {
        require(intervalSeconds in 1..10)
        val frameSource = source(sessionId)
        val delta = deltaFor(sessionId)
        mutableState.value = mutableState.value.copy(running = true, error = null, available = frameSource.availability)
        var tick = 0
        try {
            while (mutableState.value.running) {
                val seq = ++delta.sequence
                val started = System.nanoTime()
                try {
                    val execution = execute(sessionId, frameSource.frame(seq, tick), seq)
                    applyMonitorFrame(execution.raw, seq, started, sessionId, execution.connectionLatencyMs)
                    mutableState.value = mutableState.value.copy(error = null)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Throwable) {
                    val sessionState = sessions.sessionState(sessionId)
                    mutableState.value = mutableState.value.copy(error = error.message ?: error.javaClass.simpleName)
                    if (sessionState == null || sessionState == io.github.openfinalshell.android.core.model.SessionState.CLOSED) {
                        mutableState.value = mutableState.value.copy(running = false)
                        break
                    }
                    // SshSessionManager reconnects the transport independently. Keep the monitor
                    // alive and resume on the next tick once the session is READY.
                    delay(RECONNECT_POLL_MS)
                    continue
                }
                tick++
                delay(intervalSeconds * 1_000L)
            }
        } catch (error: Throwable) {
            if (mutableState.value.running) mutableState.value = mutableState.value.copy(running = false, error = error.message ?: error.javaClass.simpleName)
        }
    }

    /**
     * Returns null when the session cannot collect per-port counters at all, which is the case for
     * every local tier: the counters come from `ss -ntinH`, and Android ships no `ss`.
     */
    suspend fun collectPortTraffic(sessionId: String): PortTrafficSnapshot? {
        val frameSource = source(sessionId)
        val seq = ++deltaFor(sessionId).sequence
        val command = frameSource.portTraffic(seq) ?: run {
            mutableState.value = mutableState.value.copy(ports = null, available = frameSource.availability)
            return null
        }
        val raw = execute(sessionId, command, seq).raw
        val body = MonitorFrameParser.extractFrame(raw, seq) ?: return null
        val sections = MonitorFrameParser.splitSections(body)
        val parsed = PortTrafficParser.parse(sections["PORTS"].orEmpty()) ?: return null
        val snapshot = portRates.apply(parsed)
        mutableState.value = mutableState.value.copy(ports = snapshot)
        return snapshot
    }

    suspend fun collectStaticInfo(sessionId: String): MonitorStaticInfo? {
        val raw = execute(sessionId, source(sessionId).staticFrame(), 0).raw
        val body = MonitorFrameParser.extractFrame(raw, 0) ?: return null
        val sections = MonitorFrameParser.splitSections(body)
        val info = LinuxMonitorParser.parseStatic(
            sections["UNAME"].orEmpty(), sections["HOSTNAME"].orEmpty(), sections["NPROC"].orEmpty(),
            sections["OSRELEASE"].orEmpty(), sections["IPADDR"].orEmpty()
        )
        mutableState.value = mutableState.value.copy(staticInfo = info)
        return info
    }

    fun stop() { mutableState.value = mutableState.value.copy(running = false) }

    fun applyMonitorFrame(
        raw: String,
        sequence: Long,
        startedAtNanos: Long,
        sessionId: String,
        connectionLatencyOverrideMs: Long? = null
    ) {
        val body = MonitorFrameParser.extractFrame(raw, sequence) ?: return
        val sections = MonitorFrameParser.splitSections(body)
        val delta = deltaFor(sessionId)
        val now = System.currentTimeMillis()
        val parsedCpu = LinuxMonitorParser.parseCpu(sections["STAT"].orEmpty())
        val usage = parsedCpu?.first?.let { current -> delta.cpu?.let { LinuxMonitorParser.usage(it, current) } ?: 0.0 } ?: 0.0
        val perCore = parsedCpu?.second?.mapIndexed { index, current -> delta.cores.getOrNull(index)?.let { LinuxMonitorParser.usage(it, current) } ?: 0.0 }.orEmpty()
        delta.cpu = parsedCpu?.first
        delta.cores = parsedCpu?.second.orEmpty()
        val netCounters = LinuxMonitorParser.parseNetDev(sections["NET"].orEmpty())
        val elapsed = delta.lastSampleAtMs?.let { (now - it).coerceAtLeast(1L).toDouble() / 1000.0 }
        delta.lastSampleAtMs = now
        val net = netCounters.map { item ->
            val old = delta.net[item.iface]
            val rx = if (elapsed != null && old != null) LinuxMonitorParser.diffRate(old.first, item.rxTotalBytes, elapsed) else 0L
            val tx = if (elapsed != null && old != null) LinuxMonitorParser.diffRate(old.second, item.txTotalBytes, elapsed) else 0L
            NetworkSnapshot(item.iface, rx, tx, item.rxTotalBytes, item.txTotalBytes)
        }
        delta.net = netCounters.associate { it.iface to (it.rxTotalBytes to it.txTotalBytes) }
        val diskCounters = LinuxMonitorParser.parseDiskstats(sections["DISKIO"].orEmpty())
        val diskIo = diskCounters.map { item ->
            val old = delta.disk[item.dev]
            val read = if (elapsed != null && old != null) LinuxMonitorParser.diffRate(old.first * 512, item.readSectors * 512, elapsed) else 0L
            val write = if (elapsed != null && old != null) LinuxMonitorParser.diffRate(old.second * 512, item.writeSectors * 512, elapsed) else 0L
            DiskIoSnapshot(item.dev, read, write)
        }
        delta.disk = diskCounters.associate { it.dev to (it.readSectors to it.writeSectors) }
        val mem = LinuxMonitorParser.parseMeminfo(sections["MEM"].orEmpty()) ?: MemorySnapshot(0, 0, 0, 0, 0)
        val load = LinuxMonitorParser.parseLoadAvg(sections["LOAD"].orEmpty())
        val fs = LinuxMonitorParser.parseDf(sections["DF"].orEmpty()).map { DiskFsSnapshot(it.fs, it.mount, it.totalKb, it.usedKb, it.usePct) }
        val procs = sections["PS"]?.let { text ->
            (if (text.lineSequence().firstOrNull()?.contains("PID") == true) LinuxMonitorParser.parsePsTop(text) else LinuxMonitorParser.parsePsAux(text)).map { ProcessSnapshot(it.pid, it.name, it.cpuPct, it.memPct) }
        }
        val snapshot = MonitorSnapshot(
            ts = now,
            uptimeSec = LinuxMonitorParser.parseUptime(sections["UPTIME"].orEmpty()),
            cpu = CpuSnapshot(usage, perCore, load),
            mem = mem,
            net = net,
            diskFs = fs.takeIf { it.isNotEmpty() },
            diskIo = diskIo,
            topProcs = procs,
            conns = LinuxMonitorParser.parseSockstat(sections["SOCK"].orEmpty()),
            tcpStates = LinuxMonitorParser.parseTcpStates(sections["TCPST"].orEmpty()).takeIf { it.isNotEmpty() },
            directLatencyMs = mutableState.value.directLatencyMs,
            connectionLatencyMs = connectionLatencyOverrideMs ?: (System.nanoTime() - startedAtNanos) / 1_000_000
        )
        mutableState.value = mutableState.value.copy(snapshot = snapshot, connectionLatencyMs = snapshot.connectionLatencyMs, error = if (sections.isEmpty()) "empty monitor frame" else null)
    }

    fun applyDirectLatency(valueMs: Long?) {
        mutableState.value = mutableState.value.copy(directLatencyMs = valueMs, snapshot = mutableState.value.snapshot?.copy(directLatencyMs = valueMs))
    }

    fun applyPortFrame(raw: String) {
        val body = raw.substringAfter("@@OFS:PORTS@@", raw)
        PortTrafficParser.parse(body)?.let { mutableState.value = mutableState.value.copy(ports = portRates.apply(it)) }
    }

    private data class ExecutionResult(val raw: String, val beginAtNanos: Long?, val connectionLatencyMs: Long?)

    private suspend fun execute(sessionId: String, command: String, sequence: Long): ExecutionResult = withContext(Dispatchers.IO) {
        val started = System.nanoTime()
        val channel = sessions.openExec(sessionId, command)
        var beginAt: Long? = null
        val marker = "@@OFS:BEGIN:$sequence@@"
        val result = try {
            buildString {
                channel.output.collect {
                    val text = String(it, Charsets.UTF_8)
                    if (beginAt == null && text.contains(marker)) beginAt = System.nanoTime()
                    append(text)
                }
            }
        } finally {
            runCatching { channel.close() }
        }
        ExecutionResult(result, beginAt, beginAt?.let { (it - started) / 1_000_000 })
    }

    private companion object { const val RECONNECT_POLL_MS = 1_000L }
}
