package io.github.openfinalshell.android.core.model

import kotlinx.serialization.Serializable

@Serializable
data class ConnectionProfile(
    val id: String,
    val name: String,
    val host: String,
    val port: Int = 22,
    val username: String,
    val auth: ConnectionAuth,
    val proxy: ConnectionProxy? = null,
    /** Android currently supports SSH profiles only. Kept in the model for import compatibility. */
    val protocol: String = "ssh",
    val groupId: String? = null,
    val note: String? = null,
    val terminal: ConnectionTerminal = ConnectionTerminal(),
    val options: ConnectionOptions = ConnectionOptions(),
    val proxyMode: String? = null,
    val proxyId: String? = null,
    val jumpHostId: String? = null,
    val color: String? = null,
    val flag: String? = null,
    val lastUsedAt: Long? = null
)

@Serializable
data class ConnectionTerminal(
    val charset: String = "utf-8",
    val termType: String = "xterm-256color",
    val startupCommand: String? = null
)

@Serializable
data class ConnectionOptions(
    val keepaliveInterval: Int = 30,
    val readyTimeout: Int = 20,
    val legacyAlgorithms: Boolean = false,
    val autoReconnect: Boolean = true,
    val monitorEnabled: Boolean = false,
    val compress: Boolean = false
)

@Serializable
data class ConnectionAuth(
    val method: String,
    val passwordRef: String? = null,
    val privateKeyId: String? = null,
    val passphraseRef: String? = null
)

@Serializable
data class ConnectionProxy(
    val type: String = "none",
    val host: String? = null,
    val port: Int? = null,
    val username: String? = null,
    val passwordRef: String? = null
)

@Serializable
data class MonitorStaticInfo(
    val hostname: String,
    val kernel: String,
    val arch: String,
    val distro: String,
    val cpuCores: Int,
    val ips: List<String>
)

@Serializable
data class MonitorSnapshot(
    val ts: Long,
    val uptimeSec: Double,
    val cpu: CpuSnapshot,
    val mem: MemorySnapshot,
    val net: List<NetworkSnapshot> = emptyList(),
    val diskFs: List<DiskFsSnapshot>? = null,
    val diskIo: List<DiskIoSnapshot> = emptyList(),
    val topProcs: List<ProcessSnapshot>? = null,
    val conns: ConnectionCounts? = null,
    val tcpStates: Map<String, Int>? = null,
    val directLatencyMs: Long? = null,
    val connectionLatencyMs: Long? = null
)

@Serializable
data class CpuSnapshot(
    val usagePct: Double,
    val perCore: List<Double> = emptyList(),
    val loadAvg: List<Double> = emptyList()
)

@Serializable
data class MemorySnapshot(
    val totalKb: Long,
    val availableKb: Long,
    val usedKb: Long,
    val swapTotalKb: Long,
    val swapUsedKb: Long
)

@Serializable
data class NetworkSnapshot(
    val iface: String,
    val rxBps: Long,
    val txBps: Long,
    val rxTotalBytes: Long,
    val txTotalBytes: Long
)

@Serializable
data class DiskFsSnapshot(
    val fs: String,
    val mount: String,
    val totalKb: Long,
    val usedKb: Long,
    val usePct: Double
)

@Serializable
data class DiskIoSnapshot(val dev: String, val readBps: Long, val writeBps: Long)

@Serializable
data class ProcessSnapshot(val pid: Int, val name: String, val cpuPct: Double, val memPct: Double)

@Serializable
data class ConnectionCounts(
    val socketsUsed: Int,
    val tcpInuse: Int,
    val tcpOrphan: Int,
    val tcpTw: Int,
    val udpInuse: Int
)

@Serializable
data class PortTrafficEntry(
    val port: Int,
    val connections: Int,
    val ratesAvailable: Boolean,
    val rxBps: Long,
    val txBps: Long,
    /** Cumulative TCP_INFO counters from the server. */
    val rxTotalBytes: Long = 0,
    val txTotalBytes: Long = 0
)

@Serializable
data class PortTrafficSnapshot(val ts: Long, val ports: List<PortTrafficEntry>)

@Serializable
data class ForwardRule(
    val id: String,
    val profileId: String,
    val type: String,
    val label: String,
    val bindAddr: String,
    val bindPort: Int,
    val dstHost: String? = null,
    val dstPort: Int? = null,
    val autoStart: Boolean = false
)

enum class SessionState { CONNECTING, AUTHENTICATING, READY, RECONNECTING, CLOSED }
