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

data class MonitorState(
    val running: Boolean = false,
    val snapshot: MonitorSnapshot? = null,
    val staticInfo: MonitorStaticInfo? = null,
    val ports: PortTrafficSnapshot? = null,
    val directLatencyMs: Long? = null,
    val connectionLatencyMs: Long? = null,
    val error: String? = null
)

/** Executes and decodes the same sentinel-delimited monitor frames as the desktop client. */
class MonitorSession(private val sessions: SshSessionManager) {
    private val mutableState = MutableStateFlow(MonitorState())
    val state: StateFlow<MonitorState> = mutableState
    private val portRates = PortTrafficRateTracker()
    private var previousCpu: CpuTimes? = null
    private var previousCores: List<CpuTimes> = emptyList()
    private var previousNet: Map<String, Pair<Long, Long>> = emptyMap()
    private var previousDisk: Map<String, Pair<Long, Long>> = emptyMap()
    private var sequence = 0L

    fun reset() {
        previousCpu = null
        previousCores = emptyList()
        previousNet = emptyMap()
        previousDisk = emptyMap()
        mutableState.value = MonitorState()
    }

    suspend fun start(intervalSeconds: Int = 2) {
        val sessionId = sessions.activeSessionId.value ?: error("SSH session is not selected")
        start(sessionId, intervalSeconds)
    }

    suspend fun start(sessionId: String, intervalSeconds: Int = 2) {
        require(intervalSeconds in 1..10)
        mutableState.value = mutableState.value.copy(running = true, error = null)
        var tick = 0
        try {
            while (mutableState.value.running) {
                val seq = ++sequence
                val started = System.nanoTime()
                try {
                    val execution = execute(sessionId, MonitorCommandBuilder.frame(seq, tick % 5 == 0, tick % 3 == 0), seq)
                    applyMonitorFrame(execution.raw, seq, started, execution.connectionLatencyMs)
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

    suspend fun collectPortTraffic(sessionId: String): PortTrafficSnapshot? {
        val seq = ++sequence
        val raw = execute(sessionId, MonitorCommandBuilder.portTraffic(seq), seq).raw
        val body = MonitorFrameParser.extractFrame(raw, seq) ?: return null
        val sections = MonitorFrameParser.splitSections(body)
        val parsed = PortTrafficParser.parse(sections["PORTS"].orEmpty()) ?: return null
        val snapshot = portRates.apply(parsed)
        mutableState.value = mutableState.value.copy(ports = snapshot)
        return snapshot
    }

    suspend fun collectStaticInfo(sessionId: String): MonitorStaticInfo? {
        val raw = execute(sessionId, MonitorCommandBuilder.staticFrame(), 0).raw
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

    fun applyMonitorFrame(raw: String, sequence: Long, startedAtNanos: Long, connectionLatencyOverrideMs: Long? = null) {
        val body = MonitorFrameParser.extractFrame(raw, sequence) ?: return
        val sections = MonitorFrameParser.splitSections(body)
        val now = System.currentTimeMillis()
        val parsedCpu = LinuxMonitorParser.parseCpu(sections["STAT"].orEmpty())
        val usage = parsedCpu?.first?.let { current -> previousCpu?.let { LinuxMonitorParser.usage(it, current) } ?: 0.0 } ?: 0.0
        val perCore = parsedCpu?.second?.mapIndexed { index, current -> previousCores.getOrNull(index)?.let { LinuxMonitorParser.usage(it, current) } ?: 0.0 }.orEmpty()
        previousCpu = parsedCpu?.first
        previousCores = parsedCpu?.second.orEmpty()
        val netCounters = LinuxMonitorParser.parseNetDev(sections["NET"].orEmpty())
        val elapsed = mutableState.value.snapshot?.ts?.let { (now - it).coerceAtLeast(1L).toDouble() / 1000.0 }
        val net = netCounters.map { item ->
            val old = previousNet[item.iface]
            val rx = if (elapsed != null && old != null) LinuxMonitorParser.diffRate(old.first, item.rxTotalBytes, elapsed) else 0L
            val tx = if (elapsed != null && old != null) LinuxMonitorParser.diffRate(old.second, item.txTotalBytes, elapsed) else 0L
            NetworkSnapshot(item.iface, rx, tx, item.rxTotalBytes, item.txTotalBytes)
        }
        previousNet = netCounters.associate { it.iface to (it.rxTotalBytes to it.txTotalBytes) }
        val diskCounters = LinuxMonitorParser.parseDiskstats(sections["DISKIO"].orEmpty())
        val diskIo = diskCounters.map { item ->
            val old = previousDisk[item.dev]
            val read = if (elapsed != null && old != null) LinuxMonitorParser.diffRate(old.first * 512, item.readSectors * 512, elapsed) else 0L
            val write = if (elapsed != null && old != null) LinuxMonitorParser.diffRate(old.second * 512, item.writeSectors * 512, elapsed) else 0L
            DiskIoSnapshot(item.dev, read, write)
        }
        previousDisk = diskCounters.associate { it.dev to (it.readSectors to it.writeSectors) }
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
