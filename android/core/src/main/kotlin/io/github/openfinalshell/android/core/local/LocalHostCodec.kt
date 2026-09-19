package io.github.openfinalshell.android.core.local

import java.security.SecureRandom

/**
 * The wire format between the app and a privileged PTY host.
 *
 * Deliberately not the LAN-sync [io.github.openfinalshell.android.core.protocol.FrameCodec]: that one
 * validates against the sync frame kinds, shares a model whose schema CI diffs, and would pay JSON
 * plus base64 on every terminal chunk — about a third more bytes and an allocation per frame. Forty
 * lines with no coupling is the better trade, and it is trivially testable.
 *
 * Layout is one type byte, a four-byte big-endian length, then the payload. The C side
 * (`app/src/main/jni/ofspty.c`) implements exactly this, so the two must stay in step.
 */
object LocalHostCodec {
    const val TYPE_HELLO: Byte = 1
    const val TYPE_INPUT: Byte = 2
    const val TYPE_RESIZE: Byte = 3
    const val TYPE_CLOSE: Byte = 4
    const val TYPE_ACK: Byte = 0x81.toByte()
    const val TYPE_DATA: Byte = 0x82.toByte()
    const val TYPE_EXIT: Byte = 0x83.toByte()

    const val TOKEN_BYTES = 32
    const val HEADER_BYTES = 5

    /** Matches the host's own cap; a larger frame is a protocol error rather than a big payload. */
    const val MAX_PAYLOAD = 64 * 1024

    data class Frame(val type: Byte, val payload: ByteArray) {
        // ByteArray gives identity equality, which makes frame comparison in tests silently wrong.
        override fun equals(other: Any?): Boolean =
            other is Frame && type == other.type && payload.contentEquals(other.payload)

        override fun hashCode(): Int = 31 * type + payload.contentHashCode()
    }

    fun encode(type: Byte, payload: ByteArray = ByteArray(0)): ByteArray {
        require(payload.size <= MAX_PAYLOAD) { "payload of ${payload.size} exceeds $MAX_PAYLOAD bytes" }
        val out = ByteArray(HEADER_BYTES + payload.size)
        out[0] = type
        out[1] = (payload.size ushr 24).toByte()
        out[2] = (payload.size ushr 16).toByte()
        out[3] = (payload.size ushr 8).toByte()
        out[4] = payload.size.toByte()
        payload.copyInto(out, HEADER_BYTES)
        return out
    }

    fun encodeResize(rows: Int, cols: Int): ByteArray {
        require(rows in 0..0xFFFF && cols in 0..0xFFFF) { "window size out of range: ${rows}x$cols" }
        val payload = ByteArray(4)
        payload[0] = (rows ushr 8).toByte()
        payload[1] = rows.toByte()
        payload[2] = (cols ushr 8).toByte()
        payload[3] = cols.toByte()
        return encode(TYPE_RESIZE, payload)
    }

    fun decodeResize(payload: ByteArray): Pair<Int, Int> {
        require(payload.size == 4) { "a resize payload is 4 bytes, not ${payload.size}" }
        val rows = ((payload[0].toInt() and 0xFF) shl 8) or (payload[1].toInt() and 0xFF)
        val cols = ((payload[2].toInt() and 0xFF) shl 8) or (payload[3].toInt() and 0xFF)
        return rows to cols
    }

    fun encodeExit(status: Int): ByteArray = encode(
        TYPE_EXIT,
        byteArrayOf(
            (status ushr 24).toByte(),
            (status ushr 16).toByte(),
            (status ushr 8).toByte(),
            status.toByte()
        )
    )

    fun decodeExit(payload: ByteArray): Int {
        require(payload.size == 4) { "an exit payload is 4 bytes, not ${payload.size}" }
        return ((payload[0].toInt() and 0xFF) shl 24) or
            ((payload[1].toInt() and 0xFF) shl 16) or
            ((payload[2].toInt() and 0xFF) shl 8) or
            (payload[3].toInt() and 0xFF)
    }

    /** A fresh handshake token, as lowercase hex so it survives being passed through a shell argv. */
    fun newToken(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(TOKEN_BYTES)
        random.nextBytes(bytes)
        return bytes.joinToString("") { byte -> "%02x".format(byte) }
    }

    fun tokenBytes(hex: String): ByteArray {
        require(hex.length == TOKEN_BYTES * 2) { "a token is ${TOKEN_BYTES * 2} hex characters" }
        return ByteArray(TOKEN_BYTES) { index ->
            val high = Character.digit(hex[index * 2], 16)
            val low = Character.digit(hex[index * 2 + 1], 16)
            require(high >= 0 && low >= 0) { "token is not hexadecimal" }
            ((high shl 4) or low).toByte()
        }
    }

    /**
     * Incremental decoder.
     *
     * A socket read boundary has nothing to do with a frame boundary, so the decoder holds whatever
     * is left over. Getting this wrong shows up as a terminal that garbles output under load and
     * works fine in a quick manual test, which is exactly why it is a separate, tested unit.
     */
    class Decoder {
        private var pending = ByteArray(0)

        /** Returns every frame completed by this chunk; a partial tail is retained. */
        fun feed(bytes: ByteArray, offset: Int = 0, count: Int = bytes.size - offset): List<Frame> {
            require(offset >= 0 && count >= 0 && offset + count <= bytes.size) { "invalid feed range" }
            if (count == 0) return emptyList()
            pending = if (pending.isEmpty()) {
                bytes.copyOfRange(offset, offset + count)
            } else {
                pending + bytes.copyOfRange(offset, offset + count)
            }
            val frames = mutableListOf<Frame>()
            var cursor = 0
            while (pending.size - cursor >= HEADER_BYTES) {
                val length = ((pending[cursor + 1].toInt() and 0xFF) shl 24) or
                    ((pending[cursor + 2].toInt() and 0xFF) shl 16) or
                    ((pending[cursor + 3].toInt() and 0xFF) shl 8) or
                    (pending[cursor + 4].toInt() and 0xFF)
                require(length <= MAX_PAYLOAD) { "host sent a ${length}-byte frame, over the $MAX_PAYLOAD cap" }
                if (pending.size - cursor - HEADER_BYTES < length) break
                val start = cursor + HEADER_BYTES
                frames += Frame(pending[cursor], pending.copyOfRange(start, start + length))
                cursor = start + length
            }
            pending = if (cursor == 0) pending else pending.copyOfRange(cursor, pending.size)
            return frames
        }

        /** Bytes held back waiting for the rest of their frame; for diagnostics and tests. */
        val bufferedBytes: Int get() = pending.size
    }
}
