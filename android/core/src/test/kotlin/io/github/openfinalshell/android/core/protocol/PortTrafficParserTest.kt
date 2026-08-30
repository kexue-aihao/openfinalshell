package io.github.openfinalshell.android.core.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class PortTrafficParserTest {
    @Test
    fun `parses compact port counters and preserves unavailable rates`() {
        val snapshot = PortTrafficParser.parse("443 2 1200 800 2\n22 1 0 0 0\n", 10)
        assertNotNull(snapshot)
        assertEquals(2, snapshot.ports.size)
        assertEquals(true, snapshot.ports.first().ratesAvailable)
        assertEquals(false, snapshot.ports[1].ratesAvailable)
    }

    @Test
    fun `reports missing ss as unsupported`() {
        assertNull(PortTrafficParser.parse("@@OFS:NOSS@@"))
    }
}
