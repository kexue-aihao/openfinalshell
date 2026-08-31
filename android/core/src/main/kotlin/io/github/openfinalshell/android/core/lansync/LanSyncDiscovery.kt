package io.github.openfinalshell.android.core.lansync

import java.net.DatagramPacket
import java.net.InetAddress
import java.net.MulticastSocket
import java.io.Closeable
import kotlinx.serialization.Serializable
import io.github.openfinalshell.android.core.protocol.ProtocolJson

@Serializable
data class DiscoveryMessage(
    val magic: String,
    val proto: Int,
    val kind: String,
    val deviceId: String,
    val deviceName: String,
    val appVersion: String? = null,
    val tcpPort: Int? = null,
    val sessionId: String? = null
)

object LanSyncDiscovery {
    fun probe(deviceId: String, deviceName: String): ByteArray = encode(
        DiscoveryMessage(LanSyncConstants.MAGIC, LanSyncConstants.PROTOCOL, "probe", deviceId, deviceName)
    )

    fun announce(deviceId: String, deviceName: String, appVersion: String, tcpPort: Int, sessionId: String): ByteArray = encode(
        DiscoveryMessage(LanSyncConstants.MAGIC, LanSyncConstants.PROTOCOL, "announce", deviceId, deviceName, appVersion, tcpPort, sessionId)
    )

    fun decode(bytes: ByteArray): DiscoveryMessage? {
        if (bytes.size > LanSyncConstants.MAX_DATAGRAM_BYTES) return null
        return runCatching {
            ProtocolJson.instance.decodeFromString<DiscoveryMessage>(bytes.toString(Charsets.UTF_8)).takeIf {
                it.magic == LanSyncConstants.MAGIC && it.proto == LanSyncConstants.PROTOCOL &&
                    (it.kind == "probe" || it.kind == "announce")
            }
        }.getOrNull()
    }

    fun sendProbe(socket: MulticastSocket, deviceId: String, deviceName: String) {
        val payload = probe(deviceId, deviceName)
        socket.send(DatagramPacket(payload, payload.size, InetAddress.getByName(LanSyncConstants.DISCOVERY_GROUP), LanSyncConstants.DISCOVERY_PORT))
    }

    private fun encode(message: DiscoveryMessage): ByteArray =
        ProtocolJson.instance.encodeToString(DiscoveryMessage.serializer(), message).toByteArray(Charsets.UTF_8)
}

/** Lifecycle wrapper for UDP discovery; callers can set a short timeout while the UI is visible. */
class LanSyncDiscoveryListener : Closeable {
    private val group = InetAddress.getByName(LanSyncConstants.DISCOVERY_GROUP)
    private val socket = MulticastSocket(LanSyncConstants.DISCOVERY_PORT)

    init {
        socket.reuseAddress = true
        socket.joinGroup(group)
    }

    fun receive(timeoutMs: Int = 1_000): Pair<DiscoveryMessage, InetAddress>? {
        socket.soTimeout = timeoutMs.coerceAtLeast(1)
        val bytes = ByteArray(LanSyncConstants.MAX_DATAGRAM_BYTES)
        val packet = DatagramPacket(bytes, bytes.size)
        return runCatching {
            socket.receive(packet)
            LanSyncDiscovery.decode(packet.data.copyOf(packet.length))?.let { it to packet.address }
        }.getOrNull()
    }

    override fun close() {
        runCatching { socket.leaveGroup(group) }
        socket.close()
    }
}
