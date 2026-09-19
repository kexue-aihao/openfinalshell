package io.github.openfinalshell.android.core.monitor

import io.github.openfinalshell.android.core.ssh.SshSessionManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Two sessions monitored in turn must not measure one host against the other's counters.
 *
 * Before this, the CPU, network and disk counters were single unkeyed fields on the session, so the
 * second host's first frame was diffed against the first host's totals and reported a rate that
 * described neither machine. The numbers below are chosen so the old behaviour and the new one
 * disagree visibly: with shared counters, session B's first frame would read 45.0% instead of 0.0%.
 */
class MonitorDeltaIsolationTest {
    /** These tests never open a channel; collection is exercised through [applyMonitorFrame]. */
    private fun session() = MonitorSession(
        SshSessionManager(
            transportFactory = { error("no transport is created by these tests") },
            scope = CoroutineScope(Dispatchers.Unconfined)
        )
    )

    private fun frame(sequence: Long, cpu: String): String =
        "@@OFS:BEGIN:$sequence@@\n@@OFS:STAT@@\n$cpu\n@@OFS:END:$sequence@@\n"

    private fun usageAfter(session: MonitorSession, sequence: Long, cpu: String, sessionId: String): Double {
        session.applyMonitorFrame(frame(sequence, cpu), sequence, System.nanoTime(), sessionId)
        val snapshot = session.state.value.snapshot
        assertNotNull("the frame should have produced a snapshot", snapshot)
        return snapshot!!.cpu.usagePct
    }

    @Test fun eachSessionKeepsItsOwnCpuCounters() {
        val session = session()
        // cpu  user nice sys idle ... -> total = sum, idle = field 4 + field 5
        val a1 = "cpu  100 0 100 800 0 0 0 0 0 0"
        val a2 = "cpu  200 0 200 1600 0 0 0 0 0 0"
        val b1 = "cpu  1000 0 1000 3000 0 0 0 0 0 0"
        val b2 = "cpu  1500 0 1500 3500 0 0 0 0 0 0"

        assertEquals("the first frame of a session has nothing to diff against", 0.0, usageAfter(session, 1, a1, "A"), 0.001)
        assertEquals("B must not be diffed against A's counters", 0.0, usageAfter(session, 2, b1, "B"), 0.001)
        assertEquals("B's own second frame is a real rate", 66.7, usageAfter(session, 3, b2, "B"), 0.01)
        assertEquals("A's counters must survive B's frames untouched", 20.0, usageAfter(session, 4, a2, "A"), 0.01)
    }

    @Test fun resettingOneSessionLeavesTheOtherIntact() {
        val session = session()
        val a1 = "cpu  100 0 100 800 0 0 0 0 0 0"
        val a2 = "cpu  200 0 200 1600 0 0 0 0 0 0"
        val b1 = "cpu  1000 0 1000 3000 0 0 0 0 0 0"

        usageAfter(session, 1, a1, "A")
        usageAfter(session, 2, b1, "B")
        session.reset("B")
        assertEquals("B starts over", 0.0, usageAfter(session, 3, b1, "B"), 0.001)
        assertEquals("A is unaffected by B's reset", 20.0, usageAfter(session, 4, a2, "A"), 0.01)
    }

    @Test fun fullResetClearsEverySession() {
        val session = session()
        val a1 = "cpu  100 0 100 800 0 0 0 0 0 0"
        val a2 = "cpu  200 0 200 1600 0 0 0 0 0 0"
        usageAfter(session, 1, a1, "A")
        session.reset()
        assertEquals(0.0, usageAfter(session, 2, a2, "A"), 0.001)
    }

    /** A frame whose sentinels do not match the requested sequence is ignored outright. */
    @Test fun aFrameWithMismatchedSentinelsIsIgnored() {
        val session = session()
        // BEGIN/END say 9 while the caller asks for 1, so extraction finds no frame at all.
        session.applyMonitorFrame(frame(9, "cpu  100 0 100 800 0 0 0 0 0 0"), 1, System.nanoTime(), "A")
        assertNull("nothing should have been recorded", session.state.value.snapshot)
        assertEquals("so the next real frame still has no previous", 0.0, usageAfter(session, 2, "cpu  200 0 200 1600 0 0 0 0 0 0", "A"), 0.001)
    }
}
