package io.github.openfinalshell.android.core.protocol

import kotlin.test.Test
import kotlin.test.assertEquals

class FrameCodecTest {
    @Test
    fun `encodes big endian length and handles split frames`() {
        val codec = FrameCodec()
        val encoded = codec.encode(SyncFrame(kind = "received"))
        assertEquals(0, encoded[0].toInt())
        val first = codec.feed(encoded.copyOfRange(0, 2))
        assertEquals(0, first.size)
        val frames = codec.feed(encoded.copyOfRange(2, encoded.size))
        assertEquals(listOf("received"), frames.map { it.kind })
    }

    @Test
    fun `supports multiple frames in one chunk`() {
        val codec = FrameCodec()
        val first = codec.encode(SyncFrame(kind = "received"))
        val second = codec.encode(SyncFrame(kind = "rejected"))
        assertEquals(listOf("received", "rejected"), codec.feed(first + second).map { it.kind })
    }
}
