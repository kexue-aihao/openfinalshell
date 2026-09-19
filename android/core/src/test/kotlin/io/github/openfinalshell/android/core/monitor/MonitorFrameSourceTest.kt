package io.github.openfinalshell.android.core.monitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MonitorFrameSourceTest {
    /**
     * The pin that makes the local-shell work unable to disturb remote monitoring: the shared source
     * must reproduce the frame this app has always sent to a Linux server, byte for byte, at every
     * cadence position the monitor uses.
     */
    @Test fun linuxSourceReproducesTheExistingCommandBuilderExactly() {
        for (tick in 0..15) {
            assertEquals(
                "tick $tick diverged from MonitorCommandBuilder",
                MonitorCommandBuilder.frame(7, tick % 5 == 0, tick % 3 == 0),
                LinuxMonitorFrameSource.frame(7, tick)
            )
        }
        assertEquals(MonitorCommandBuilder.staticFrame(), LinuxMonitorFrameSource.staticFrame())
        assertEquals(MonitorCommandBuilder.portTraffic(3), LinuxMonitorFrameSource.portTraffic(3))
    }

    @Test fun linuxSourceClaimsEveryMetric() {
        val availability = LinuxMonitorFrameSource.availability
        assertTrue(availability.memory)
        assertTrue(availability.disk)
        assertTrue(availability.processes)
        assertTrue(availability.tcpStates)
        assertTrue(availability.portTraffic)
    }

    @Test fun localSourceEmitsOnlyProbedSections() {
        val frame = LocalMonitorFrameSource(capabilities("STAT", "MEM")).frame(5, 0)
        assertTrue(frame.contains("@@OFS:STAT@@"))
        assertTrue(frame.contains("@@OFS:MEM@@"))
        assertFalse("an unprobed section must not appear at all", frame.contains("@@OFS:NET@@"))
        assertFalse(frame.contains("@@OFS:DISKIO@@"))
        assertFalse(frame.contains("@@OFS:DF@@"))
        assertFalse(frame.contains("@@OFS:PS@@"))
        // The sentinels the parser keys on must still bracket the frame.
        assertTrue(frame.startsWith("printf '%s\\n' '@@OFS:BEGIN:5@@'\n"))
        assertTrue(frame.endsWith("printf '%s\\n' '@@OFS:END:5@@'\n"))
    }

    /**
     * Port traffic is unavailable at every local tier — the counters come from `ss -ntinH`, and
     * Android ships no `ss`. Reporting null is what lets the panel say so instead of showing an
     * empty list as though nothing were listening.
     */
    @Test fun localSourceNeverOffersPortTraffic() {
        assertNull(LocalMonitorFrameSource(capabilities("STAT", "MEM", "DF")).portTraffic(1))
        assertFalse(LocalMonitorFrameSource(capabilities("STAT", "MEM", "DF")).availability.portTraffic)
    }

    @Test fun localSourceAvailabilityReflectsTheProbe() {
        val narrow = LocalMonitorFrameSource(capabilities("STAT")).availability
        assertFalse(narrow.memory)
        assertFalse(narrow.disk)
        assertFalse(narrow.processes)
        assertFalse(narrow.tcpStates)

        val wide = LocalMonitorFrameSource(
            capabilities("STAT", "MEM", "DF", uid = 2000, psFlavour = PsFlavour.SORTED, tcpTableReadable = true, hasAwk = true)
        ).availability
        assertTrue(wide.memory)
        assertTrue(wide.disk)
        assertTrue(wide.processes)
        assertTrue(wide.tcpStates)
    }

    /** TCP states need both a readable table and something to aggregate it with. */
    @Test fun tcpStatesRequireBothTheTableAndAwk() {
        val tableOnly = LocalMonitorFrameSource(capabilities("STAT", tcpTableReadable = true, hasAwk = false))
        assertFalse(tableOnly.availability.tcpStates)
        val awkOnly = LocalMonitorFrameSource(capabilities("STAT", tcpTableReadable = false, hasAwk = true))
        assertFalse(awkOnly.availability.tcpStates)
        val both = LocalMonitorFrameSource(capabilities("STAT", tcpTableReadable = true, hasAwk = true))
        assertTrue(both.availability.tcpStates)
        assertTrue(both.frame(1, 0).contains("@@OFS:TCPST@@"))
    }

    @Test fun localSourceUsesTheReportedPsFlavour() {
        assertTrue(LocalMonitorFrameSource(capabilities("STAT", psFlavour = PsFlavour.SORTED)).frame(1, 0).contains("--sort=-pcpu"))
        assertTrue(LocalMonitorFrameSource(capabilities("STAT", psFlavour = PsFlavour.EXTENDED)).frame(1, 0).contains("ps -eo pid,pcpu,pmem,comm"))
        assertTrue(LocalMonitorFrameSource(capabilities("STAT", psFlavour = PsFlavour.AUX)).frame(1, 0).contains("ps aux"))
        assertFalse(LocalMonitorFrameSource(capabilities("STAT", psFlavour = PsFlavour.NONE)).frame(1, 0).contains("@@OFS:PS@@"))
    }

    @Test fun localSourceHonoursThePeriodicCadence() {
        val source = LocalMonitorFrameSource(capabilities("STAT", "DF", psFlavour = PsFlavour.SORTED))
        assertTrue("tick 0 includes df and ps", source.frame(1, 0).contains("@@OFS:DF@@"))
        assertTrue(source.frame(1, 0).contains("@@OFS:PS@@"))
        assertFalse("tick 1 includes neither", source.frame(1, 1).contains("@@OFS:DF@@"))
        assertFalse(source.frame(1, 1).contains("@@OFS:PS@@"))
        assertTrue("tick 3 includes ps only", source.frame(1, 3).contains("@@OFS:PS@@"))
        assertFalse(source.frame(1, 3).contains("@@OFS:DF@@"))
    }

    /** `timeout` is a toybox applet on modern Android but not guaranteed; a hung collector must not
     *  stall the section it guards forever. */
    @Test fun localSourceWrapsCollectorsInTimeoutOnlyWhenAvailable() {
        assertTrue(LocalMonitorFrameSource(capabilities("DF", hasTimeout = true)).frame(1, 0).contains("timeout 3 df -kP"))
        assertTrue(LocalMonitorFrameSource(capabilities("DF", hasTimeout = false)).frame(1, 0).contains("\ndf -kP"))
    }

    /**
     * The static frame reuses `LinuxMonitorParser.parseStatic` by emitting Android facts in the
     * shape it already understands, rather than adding a second parser.
     */
    @Test fun localStaticFrameFeedsTheExistingParser() {
        val frame = LocalMonitorFrameSource(capabilities("STAT")).staticFrame()
        assertTrue(frame.contains("PRETTY_NAME="))
        assertTrue(frame.contains("@@OFS:UNAME@@"))
        assertTrue(frame.contains("@@OFS:OSRELEASE@@"))
        assertTrue(frame.contains("getprop ro.build.version.release"))
    }

    private fun capabilities(
        vararg sections: String,
        uid: Int = -1,
        psFlavour: PsFlavour = PsFlavour.NONE,
        tcpTableReadable: Boolean = false,
        hasAwk: Boolean = false,
        hasTimeout: Boolean = false
    ) = LocalCapabilities(
        uid = uid,
        sections = sections.toSet(),
        hasTimeout = hasTimeout,
        hasAwk = hasAwk,
        hasPsSort = psFlavour == PsFlavour.SORTED,
        psFlavour = psFlavour,
        tcpTableReadable = tcpTableReadable
    )
}
