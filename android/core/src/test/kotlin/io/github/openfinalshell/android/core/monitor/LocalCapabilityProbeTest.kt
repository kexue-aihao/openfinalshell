package io.github.openfinalshell.android.core.monitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalCapabilityProbeTest {
    private fun probe(vararg lines: String): String =
        (listOf("@@OFS:BEGIN:0@@", "@@OFS:PROBE@@") + lines + "@@OFS:END:0@@").joinToString("\n") + "\n"

    @Test fun readsAnAppTierProbe() {
        val capabilities = LocalCapabilityProbe.parse(
            probe(
                "uid=10123",
                "timeout=0",
                "awk=0",
                "df=1",
                "stat=1", "mem=1", "net=1", "uptime=1", "load=1", "diskio=1", "sock=1",
                "tcp=0",
                "pssort=0", "psext=1", "psaux=1"
            )
        )
        assertEquals(10123, capabilities.uid)
        assertEquals(setOf("STAT", "MEM", "NET", "UPTIME", "LOAD", "DISKIO", "SOCK", "DF"), capabilities.sections)
        assertFalse(capabilities.hasTimeout)
        assertFalse(capabilities.hasAwk)
        assertFalse(capabilities.tcpTableReadable)
        assertEquals(PsFlavour.EXTENDED, capabilities.psFlavour)
    }

    /** The shell tier answers more: `/proc/net/tcp` becomes readable and toybox `ps` may take `-o`. */
    @Test fun readsAShellTierProbe() {
        val capabilities = LocalCapabilityProbe.parse(
            probe(
                "uid=2000",
                "timeout=1", "awk=1", "df=1",
                "stat=1", "mem=1", "net=1", "uptime=1", "load=1", "diskio=1", "sock=1", "tcp=1",
                "pssort=0", "psext=1", "psaux=1"
            )
        )
        assertEquals(2000, capabilities.uid)
        assertTrue(capabilities.tcpTableReadable)
        assertTrue(capabilities.hasAwk)
        assertTrue(capabilities.hasTimeout)
        // Ordering matters: -eo is preferred over aux, and --sort over both when present.
        assertEquals(PsFlavour.EXTENDED, capabilities.psFlavour)
    }

    @Test fun prefersTheMostCapablePsFlavour() {
        assertEquals(PsFlavour.SORTED, LocalCapabilityProbe.parse(probe("pssort=1", "psext=1", "psaux=1")).psFlavour)
        assertEquals(PsFlavour.EXTENDED, LocalCapabilityProbe.parse(probe("pssort=0", "psext=1", "psaux=1")).psFlavour)
        assertEquals(PsFlavour.AUX, LocalCapabilityProbe.parse(probe("pssort=0", "psext=0", "psaux=1")).psFlavour)
        assertEquals(PsFlavour.NONE, LocalCapabilityProbe.parse(probe("pssort=0", "psext=0", "psaux=0")).psFlavour)
        assertEquals(PsFlavour.NONE, LocalCapabilityProbe.parse(probe()).psFlavour)
    }

    /**
     * A probe that half-succeeds must still be usable. A missing key means "cannot collect that",
     * which is a limitation of the device, not a failure of the session.
     */
    @Test fun missingKeysMeanUnavailableRatherThanFailure() {
        val capabilities = LocalCapabilityProbe.parse(probe("uid=10123", "stat=1"))
        assertEquals(setOf("STAT"), capabilities.sections)
        assertFalse(capabilities.hasTimeout)
        assertFalse(capabilities.hasAwk)
        assertEquals(PsFlavour.NONE, capabilities.psFlavour)
        assertEquals(10123, capabilities.uid)
    }

    @Test fun toleratesNoiseUnknownKeysAndUnparsableValues() {
        val capabilities = LocalCapabilityProbe.parse(
            "some banner text\n" +
                probe(
                    "uid=not-a-number",
                    "unknown_key=1",
                    "@@OFS:WEIRD@@",
                    "stat=1",
                    "mem="
                )
        )
        assertEquals("an unparsable uid must not invent one", -1, capabilities.uid)
        assertEquals(setOf("STAT"), capabilities.sections)
        assertFalse("an empty value is not a yes", capabilities.sections.contains("MEM"))
    }

    @Test fun treatsAnythingOtherThanOneAsNo() {
        val capabilities = LocalCapabilityProbe.parse(probe("stat=1", "mem=0", "net=yes", "sock=1 ", "load=01"))
        assertEquals(setOf("STAT", "SOCK"), capabilities.sections)
    }

    @Test fun probeCommandCarriesTheSentinelFrameAndGuardsEveryProbe() {
        val command = LocalCapabilityProbe.probeCommand()
        assertTrue(command.startsWith("printf '%s\\n' '@@OFS:BEGIN:0@@'"))
        assertTrue(command.contains("@@OFS:PROBE@@"))
        assertTrue(command.endsWith("printf '%s\\n' '@@OFS:END:0@@'\n"))
        // Every probe reports a value rather than failing the session, and the capability lookups
        // use `command -v` so a missing applet is a "0" and not a shell error.
        assertTrue(command.contains("command -v timeout"))
        assertTrue(command.contains("command -v awk"))
        assertTrue(command.contains("command -v df"))
        assertFalse("an unguarded read would abort the frame", command.contains("cat /proc/stat\n"))
    }
}
