package io.github.openfinalshell.android.core.forward

import java.net.InetAddress
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ForwardingServiceTest {
    @Test
    fun `socks greeting treats method count as unsigned`() {
        val frame = ByteArray(130).also {
            it[0] = 5
            it[1] = 128.toByte()
            it[2 + 127] = 0
        }
        assertTrue(Socks5Parser.greeting(frame))
        assertFalse(Socks5Parser.greeting(frame.copyOf(129)))
    }

    @Test
    fun `socks connect parses ipv4 and port`() {
        val frame = byteArrayOf(5, 1, 0, 1) + InetAddress.getByName("127.0.0.1").address +
            ByteBuffer.allocate(2).order(ByteOrder.BIG_ENDIAN).putShort(8443).array()
        val request = Socks5Parser.connect(frame)
        assertEquals("127.0.0.1", request.host)
        assertEquals(8443, request.port)
    }
}
