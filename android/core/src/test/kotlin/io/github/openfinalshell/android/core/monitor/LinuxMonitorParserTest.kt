package io.github.openfinalshell.android.core.monitor

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class LinuxMonitorParserTest {
    @Test
    fun `parses memory and socket counters`() {
        val mem = LinuxMonitorParser.parseMeminfo("MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 100 kB\nSwapFree: 25 kB\n")
        assertNotNull(mem)
        assertEquals(600, mem.usedKb)
        val conns = LinuxMonitorParser.parseSockstat("sockets: used 12\nTCP: inuse 3 orphan 1 tw 2\nUDP: inuse 4 mem 1\n")
        assertNotNull(conns)
        assertEquals(3, conns.tcpInuse)
        assertEquals(4, conns.udpInuse)
    }
}
