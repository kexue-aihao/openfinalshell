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

    @Test
    fun `computes rates from cumulative counters`() {
        val tracker = PortTrafficRateTracker()
        val first = tracker.apply(PortTrafficParser.parse("443 1 100 50 1\n", 1_000)!!)
        assertEquals(false, first.ports.single().ratesAvailable)
        val second = tracker.apply(PortTrafficParser.parse("443 1 300 150 1\n", 3_000)!!)
        assertEquals(true, second.ports.single().ratesAvailable)
        assertEquals(100, second.ports.single().rxBps)
        assertEquals(50, second.ports.single().txBps)
    }
}
