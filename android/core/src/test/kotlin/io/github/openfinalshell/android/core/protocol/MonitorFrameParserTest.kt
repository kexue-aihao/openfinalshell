package io.github.openfinalshell.android.core.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MonitorFrameParserTest {
    @Test
    fun `splits sections and extracts sequence`() {
        val raw = "noise\n@@OFS:BEGIN:7@@\n@@OFS:STAT@@\ncpu 1\n@@OFS:MEM@@\nMemTotal: 10\n@@OFS:END:7@@\n"
        val body = MonitorFrameParser.extractFrame(raw, 7)
        requireNotNull(body)
        assertEquals("cpu 1", MonitorFrameParser.splitSections(body)["STAT"])
        assertEquals("MemTotal: 10", MonitorFrameParser.splitSections(body)["MEM"])
        assertNull(MonitorFrameParser.extractFrame(raw, 8))
    }
}
