package io.github.openfinalshell.android.core.lansync

object LanSyncConstants {
    const val PROTOCOL = 1
    const val MAGIC = "OFSSYNC1"
    const val DISCOVERY_PORT = 52133
    const val DISCOVERY_GROUP = "239.255.77.88"
    const val MAX_DATAGRAM_BYTES = 1400
    const val HANDSHAKE_MAX_FRAME_BYTES = 64 * 1024
    const val MAX_FRAME_BYTES = 64 * 1024 * 1024
}
