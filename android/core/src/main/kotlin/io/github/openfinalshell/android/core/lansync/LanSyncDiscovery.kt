package io.github.openfinalshell.android.core.lansync

import java.net.DatagramPacket
import java.net.InetAddress
import java.net.MulticastSocket
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
