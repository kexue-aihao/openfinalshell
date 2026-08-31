package io.github.openfinalshell.android.core.protocol

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import io.github.openfinalshell.android.core.lansync.LanSyncConstants

@Serializable
data class SyncFrame(
    val kind: String,
    val magic: String? = null,
    val proto: Int? = null,
    val deviceId: String? = null,
    val deviceName: String? = null,
    val appVersion: String? = null,
    val senderPub: String? = null,
    val receiverPub: String? = null,
    val salt: String? = null,
    val sessionId: String? = null,
    val mac: String? = null,
    val envelope: String? = null,
    val profiles: Int? = null,
    val snippets: Int? = null,
    val forwards: Int? = null,
    val knownHosts: Int? = null,
    val secrets: Int? = null,
    val skipped: Int? = null,
    val code: String? = null,
    val params: Map<String, JsonElement>? = null
)

/** 4-byte big-endian length prefix used by the existing LanSync TCP protocol. */
class FrameCodec(private var maxBytes: Int = LanSyncConstants.HANDSHAKE_MAX_FRAME_BYTES) {
    private val pending = ByteArrayOutputStream()

    fun setMaxBytes(value: Int) {
        require(value in 1..LanSyncConstants.MAX_FRAME_BYTES)
        maxBytes = value
    }

    fun encode(frame: SyncFrame): ByteArray {
        validate(frame)
        val body = ProtocolJson.instance.encodeToString(SyncFrame.serializer(), frame).toByteArray(Charsets.UTF_8)
        require(body.size in 1..maxBytes) { "lansync frame length is invalid: ${body.size}" }
        return ByteBuffer.allocate(4 + body.size).order(ByteOrder.BIG_ENDIAN)
            .putInt(body.size)
            .put(body)
            .array()
    }

    fun feed(chunk: ByteArray): List<SyncFrame> {
        pending.write(chunk)
        val frames = mutableListOf<SyncFrame>()
        while (pending.size() >= 4) {
            val bytes = pending.toByteArray()
            val length = ByteBuffer.wrap(bytes, 0, 4).order(ByteOrder.BIG_ENDIAN).int
            require(length in 1..maxBytes) { "lansync frame length is invalid: $length" }
            if (bytes.size < length + 4) break
            val payload = bytes.copyOfRange(4, length + 4)
            val remainder = bytes.copyOfRange(length + 4, bytes.size)
            pending.reset()
            pending.write(remainder)
            val frame = ProtocolJson.instance.decodeFromString(SyncFrame.serializer(), payload.toString(Charsets.UTF_8))
            validate(frame)
            frames += frame
        }
        return frames
    }

    private fun validate(frame: SyncFrame) {
        require(frame.kind in VALID_KINDS) { "unsupported lansync frame kind: ${frame.kind}" }
        when (frame.kind) {
            "hello" -> require(frame.magic == LanSyncConstants.MAGIC && frame.proto == LanSyncConstants.PROTOCOL &&
                !frame.deviceId.isNullOrBlank() && !frame.senderPub.isNullOrBlank())
            "hello-ack" -> require(!frame.deviceId.isNullOrBlank() && !frame.receiverPub.isNullOrBlank() &&
                !frame.salt.isNullOrBlank() && !frame.sessionId.isNullOrBlank())
            "confirm-s", "confirm-r" -> require(!frame.mac.isNullOrBlank())
            "payload" -> require(!frame.envelope.isNullOrBlank())
            "applied" -> require((frame.profiles ?: -1) >= 0 && (frame.snippets ?: -1) >= 0 &&
                (frame.forwards ?: -1) >= 0 && (frame.knownHosts ?: -1) >= 0 &&
                (frame.secrets ?: -1) >= 0 && (frame.skipped ?: -1) >= 0)
            "received", "rejected" -> Unit
            "error" -> require(!frame.code.isNullOrBlank())
        }
    }

    private companion object {
        val VALID_KINDS = setOf(
            "hello", "hello-ack", "confirm-s", "confirm-r", "payload",
            "received", "applied", "rejected", "error"
        )
    }
}
