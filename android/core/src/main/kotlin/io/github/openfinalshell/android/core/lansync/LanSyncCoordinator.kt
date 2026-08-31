package io.github.openfinalshell.android.core.lansync

import java.io.Closeable
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class LanSyncPeer(
    val deviceId: String,
    val deviceName: String,
    val appVersion: String,
    val address: String,
    val tcpPort: Int
)

data class LanSyncReceiverInfo(val tcpPort: Int, val pairingCode: String)

/**
 * Android socket lifecycle for the existing LAN Sync protocol.
 *
 * Discovery remains best effort: the receiver answers probes directly, while the sender uses
 * both multicast and broadcast. The TCP payload itself is always handled by LanSyncSession, so
 * the X25519/HKDF/scrypt handshake and four-byte frame format stay identical to the desktop side.
 */
class LanSyncCoordinator(private val scope: CoroutineScope) : Closeable {
    private val lock = Any()
    private var receiveServer: ServerSocket? = null
    private var discoverySocket: MulticastSocket? = null
    private var receiveJobs: List<Job> = emptyList()
    private var receiveCode: String? = null
    private val sessionInFlight = AtomicBoolean(false)

    suspend fun scan(selfDeviceId: String, deviceName: String, timeoutMs: Long = 2_500): List<LanSyncPeer> =
        withContext(Dispatchers.IO) {
            val found = linkedMapOf<String, LanSyncPeer>()
            DatagramSocket().use { socket ->
                socket.broadcast = true
                val payload = LanSyncDiscovery.probe(selfDeviceId, deviceName)
                val group = InetAddress.getByName(LanSyncConstants.DISCOVERY_GROUP)
                val broadcast = InetAddress.getByName("255.255.255.255")
                runCatching {
                    socket.send(DatagramPacket(payload, payload.size, group, LanSyncConstants.DISCOVERY_PORT))
                    socket.send(DatagramPacket(payload, payload.size, broadcast, LanSyncConstants.DISCOVERY_PORT))
                }
                val deadline = System.nanoTime() + timeoutMs.coerceAtLeast(100) * 1_000_000L
                val bytes = ByteArray(LanSyncConstants.MAX_DATAGRAM_BYTES)
                while (System.nanoTime() < deadline) {
                    val remaining = ((deadline - System.nanoTime()) / 1_000_000L).coerceAtLeast(1L)
                    socket.soTimeout = remaining.coerceAtMost(250L).toInt()
                    val packet = DatagramPacket(bytes, bytes.size)
                    try {
                        socket.receive(packet)
                    } catch (_: SocketTimeoutException) {
                        continue
                    } catch (_: Throwable) {
                        break
                    }
                    val message = LanSyncDiscovery.decode(packet.data.copyOf(packet.length)) ?: continue
                    if (message.kind != "announce" || message.deviceId == selfDeviceId) continue
                    val port = message.tcpPort ?: continue
                    val key = "${message.deviceId}@${packet.address.hostAddress}:$port"
                    found.putIfAbsent(
                        key,
                        LanSyncPeer(
                            message.deviceId,
                            message.deviceName,
                            message.appVersion.orEmpty(),
                            packet.address.hostAddress.orEmpty(),
                            port
                        )
                    )
                }
            }
            found.values.toList()
        }

    suspend fun send(
        peer: LanSyncPeer,
        deviceId: String,
        deviceName: String,
        appVersion: String,
        pairingCode: CharArray,
        envelopeFactory: suspend (CharArray) -> String
    ): LanSyncApplyResult = withContext(Dispatchers.IO) {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(peer.address, peer.tcpPort), CONNECT_TIMEOUT_MS)
            socket.soTimeout = SESSION_TIMEOUT_MS
            LanSyncSession(socket).send(
                deviceId,
                deviceName,
                appVersion,
                pairingCode,
                envelopeFactory = envelopeFactory
            )
        }
    }

    suspend fun startReceiver(
        deviceId: String,
        deviceName: String,
        appVersion: String,
        apply: suspend (envelope: String, channelPassphrase: CharArray) -> LanSyncApplyResult
    ): LanSyncReceiverInfo = withContext(Dispatchers.IO) {
        synchronized(lock) {
            check(receiveServer == null) { "LAN Sync receiver is already running" }
        }
        val server = ServerSocket(0, 8, InetAddress.getByName("0.0.0.0"))
        val code = generatePairingCode()
        val sessionId = java.util.UUID.randomUUID().toString()
        val discovery = MulticastSocket(LanSyncConstants.DISCOVERY_PORT).apply {
            reuseAddress = true
            joinGroup(InetAddress.getByName(LanSyncConstants.DISCOVERY_GROUP))
        }
        synchronized(lock) {
            receiveServer = server
            discoverySocket = discovery
            receiveCode = code
        }
        val tcpJob = scope.launch(Dispatchers.IO) {
            while (isActive && !server.isClosed) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                if (!sessionInFlight.compareAndSet(false, true)) {
                    runCatching { socket.close() }
                    continue
                }
                launch(Dispatchers.IO) {
                    try {
                        val currentCode = synchronized(lock) { receiveCode } ?: return@launch
                        LanSyncSession(socket).receive(
                            deviceId,
                            deviceName,
                            appVersion,
                            currentCode.toCharArray(),
                            apply
                        )
                    } catch (_: Throwable) {
                        // A bad pairing code or malformed frame only ends this TCP attempt. The
                        // receiver remains available for a new probe/session.
                    } finally {
                        sessionInFlight.set(false)
                        runCatching { socket.close() }
                    }
                }
            }
        }
        val discoveryJob = scope.launch(Dispatchers.IO) {
            val bytes = ByteArray(LanSyncConstants.MAX_DATAGRAM_BYTES)
            val announce = {
                LanSyncDiscovery.announce(deviceId, deviceName, appVersion, server.localPort, sessionId)
            }
            var lastAnnounce = 0L
            while (isActive && !discovery.isClosed) {
                discovery.soTimeout = DISCOVERY_TICK_MS
                val packet = DatagramPacket(bytes, bytes.size)
                try {
                    discovery.receive(packet)
                    val message = LanSyncDiscovery.decode(packet.data.copyOf(packet.length))
                    if (message?.kind == "probe" && message.deviceId != deviceId) {
                        val response = announce()
                        discovery.send(DatagramPacket(response, response.size, packet.address, packet.port))
                    }
                } catch (_: SocketTimeoutException) {
                    // Periodic multicast announcement compensates for a lost probe/reply.
                } catch (_: Throwable) {
                    if (!discovery.isClosed) break
                }
                val now = System.currentTimeMillis()
                if (now - lastAnnounce >= ANNOUNCE_INTERVAL_MS) {
                    val response = announce()
                    runCatching {
                        discovery.send(
                            DatagramPacket(
                                response,
                                response.size,
                                InetAddress.getByName(LanSyncConstants.DISCOVERY_GROUP),
                                LanSyncConstants.DISCOVERY_PORT
                            )
                        )
                    }
                    lastAnnounce = now
                }
            }
        }
        synchronized(lock) { receiveJobs = listOf(tcpJob, discoveryJob) }
        LanSyncReceiverInfo(server.localPort, code)
    }

    fun stopReceiver() {
        val jobs = synchronized(lock) {
            receiveCode = null
            val current = receiveJobs
            receiveJobs = emptyList()
            runCatching { discoverySocket?.leaveGroup(InetAddress.getByName(LanSyncConstants.DISCOVERY_GROUP)) }
            runCatching { discoverySocket?.close() }
            runCatching { receiveServer?.close() }
            discoverySocket = null
            receiveServer = null
            current
        }
        jobs.forEach(Job::cancel)
        sessionInFlight.set(false)
    }

    override fun close() = stopReceiver()

    private fun generatePairingCode(): String =
        SecureRandom().nextInt(1_000_000).toString().padStart(6, '0')

    private companion object {
        const val CONNECT_TIMEOUT_MS = 10_000
        const val SESSION_TIMEOUT_MS = 60_000
        const val DISCOVERY_TICK_MS = 2_000
        const val ANNOUNCE_INTERVAL_MS = 2_000L
    }
}
