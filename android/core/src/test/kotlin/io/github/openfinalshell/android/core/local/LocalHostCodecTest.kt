package io.github.openfinalshell.android.core.local

import java.security.SecureRandom
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The framing is tested against split and coalesced reads specifically.
 *
 * A socket read boundary has nothing to do with a frame boundary, so a decoder that only works when
 * one read carries exactly one frame passes a naive manual test and garbles output under load.
 */
class LocalHostCodecTest {
    @Test fun roundTripsASingleFrame() {
        val encoded = LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, "hello".toByteArray())
        val frames = LocalHostCodec.Decoder().feed(encoded)
        assertEquals(1, frames.size)
        assertEquals(LocalHostCodec.TYPE_DATA, frames[0].type)
        assertArrayEquals("hello".toByteArray(), frames[0].payload)
    }

    @Test fun reassemblesAFrameSplitAcrossEveryByteBoundary() {
        val encoded = LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, "abcdef".toByteArray())
        val decoder = LocalHostCodec.Decoder()
        val collected = mutableListOf<LocalHostCodec.Frame>()
        for (byte in encoded) {
            collected += decoder.feed(byteArrayOf(byte))
        }
        assertEquals("one frame must come out of ${encoded.size} single-byte reads", 1, collected.size)
        assertArrayEquals("abcdef".toByteArray(), collected[0].payload)
        assertEquals(0, decoder.bufferedBytes)
    }

    /** The opposite hazard: several frames arriving in one read must all be produced. */
    @Test fun splitsSeveralFramesArrivingInOneChunk() {
        val stream = LocalHostCodec.encode(LocalHostCodec.TYPE_ACK) +
            LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, "one".toByteArray()) +
            LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, "two".toByteArray())
        val frames = LocalHostCodec.Decoder().feed(stream)
        assertEquals(3, frames.size)
        assertEquals(LocalHostCodec.TYPE_ACK, frames[0].type)
        assertEquals(0, frames[0].payload.size)
        assertArrayEquals("one".toByteArray(), frames[1].payload)
        assertArrayEquals("two".toByteArray(), frames[2].payload)
    }

    @Test fun holdsBackAPartialTrailingFrameUntilItIsComplete() {
        val first = LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, "done".toByteArray())
        val second = LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, "pending".toByteArray())
        val decoder = LocalHostCodec.Decoder()
        assertEquals(1, decoder.feed(first + second.copyOfRange(0, 4)).size)
        assertEquals(4, decoder.bufferedBytes)
        // The rest of the header completes, then the payload.
        assertEquals(0, decoder.feed(second.copyOfRange(4, 6)).size)
        val frames = decoder.feed(second.copyOfRange(6, second.size))
        assertEquals(1, frames.size)
        assertArrayEquals("pending".toByteArray(), frames[0].payload)
        assertEquals(0, decoder.bufferedBytes)
    }

    @Test fun encodesAndDecodesResize() {
        val payload = LocalHostCodec.encodeResize(rows = 12, cols = 40)
        val frames = LocalHostCodec.Decoder().feed(payload)
        assertEquals(1, frames.size)
        assertEquals(LocalHostCodec.TYPE_RESIZE, frames[0].type)
        assertEquals(12 to 40, LocalHostCodec.decodeResize(frames[0].payload))
    }

    /** A window size is a 16-bit field on the wire; a larger one must fail loudly, not truncate. */
    @Test fun refusesAWindowSizeThatWouldNotFitTheWire() {
        LocalHostCodec.encodeResize(rows = 65535, cols = 65535)
        assertThrows(IllegalArgumentException::class.java) { LocalHostCodec.encodeResize(rows = 65536, cols = 80) }
    }

    @Test fun encodesAndDecodesExitStatus() {
        for (status in listOf(0, 1, 3, 127, 137, 255)) {
            val frames = LocalHostCodec.Decoder().feed(LocalHostCodec.encodeExit(status))
            assertEquals(LocalHostCodec.TYPE_EXIT, frames[0].type)
            assertEquals(status, LocalHostCodec.decodeExit(frames[0].payload))
        }
    }

    @Test fun tokensAreHexAndRoundTrip() {
        val token = LocalHostCodec.newToken(SecureRandom())
        assertEquals(LocalHostCodec.TOKEN_BYTES * 2, token.length)
        assertTrue("a token has to survive being passed through a shell argv", token.matches(Regex("[0-9a-f]+")))
        assertEquals(LocalHostCodec.TOKEN_BYTES, LocalHostCodec.tokenBytes(token).size)
        assertArrayEquals(LocalHostCodec.tokenBytes(token), LocalHostCodec.tokenBytes(token))
    }

    @Test fun aBadTokenIsRejectedRatherThanSilentlyTruncated() {
        assertThrows(IllegalArgumentException::class.java) { LocalHostCodec.tokenBytes("00") }
        assertThrows(IllegalArgumentException::class.java) { LocalHostCodec.tokenBytes("z".repeat(LocalHostCodec.TOKEN_BYTES * 2)) }
    }

    /** The host caps its frames at the same size; anything larger is a protocol error. */
    @Test fun refusedAnOversizedFrameRatherThanBufferingIt() {
        assertThrows(IllegalArgumentException::class.java) {
            LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, ByteArray(LocalHostCodec.MAX_PAYLOAD + 1))
        }
        // A length field beyond the cap is rejected before the payload is buffered, so a hostile
        // length cannot make the decoder allocate.
        val hostile = byteArrayOf(LocalHostCodec.TYPE_DATA, 0x7F, 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte())
        assertThrows(IllegalArgumentException::class.java) { LocalHostCodec.Decoder().feed(hostile) }
    }

    @Test fun framesWithTheSameContentCompareEqual() {
        // ByteArray gives identity equality, which would make frame assertions silently wrong.
        val left = LocalHostCodec.Decoder().feed(LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, "x".toByteArray()))
        val right = LocalHostCodec.Decoder().feed(LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, "x".toByteArray()))
        assertEquals(left[0], right[0])
    }
}
