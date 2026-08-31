package io.github.openfinalshell.android.core.monitor

import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertEquals

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

    @Test
    fun `parses disk filesystems and tcp states`() {
        val disks = LinuxMonitorParser.parseDiskstats("8 0 sda 10 0 200 0 20 0 400 0 0 0 0\n8 1 sda1 1 0 2 0 3 0 4 0 0 0 0\n")
        assertEquals(listOf(DiskCounters("sda", 200, 400)), disks)
        val fs = LinuxMonitorParser.parseDf("Filesystem 1024-blocks Used Available Capacity Mounted-on\n/dev/sda1 1000 250 750 25% /\ntmpfs 100 1 99 1% /run\n")
        assertEquals("/", fs.single().mount)
        assertEquals(25.0, fs.single().usePct)
        assertEquals(3, LinuxMonitorParser.parseTcpStates("01 2\n0A 1\nff 3\n").size)
    }
}
