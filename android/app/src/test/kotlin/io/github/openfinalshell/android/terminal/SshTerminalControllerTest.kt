package io.github.openfinalshell.android.terminal

import com.termux.terminal.TerminalEmulator
import io.github.openfinalshell.android.core.terminal.TerminalCursorStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SshTerminalControllerTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @Test
    fun `measures viewport using complete cells and content padding`() {
        assertEquals(
            TerminalViewport(columns = 20, rows = 10),
            measureTerminalViewport(
                width = 210,
                height = 170,
                fontWidth = 10.25f,
                lineSpacing = 16,
                paddingLeft = 2,
                paddingRight = 3,
                paddingTop = 5,
                paddingBottom = 5
            )
        )
        assertNull(measureTerminalViewport(0, 170, 10f, 16))
    }

    @Test
    fun `renders ansi osc and carriage return through termux emulator`() {
        val controller = SshTerminalController(scope, {}, initialCols = 40, initialRows = 4)

        controller.write("before\u001b[2J\u001b[H\u001b[31mred\u001b[0m\rready\u001b]0;remote host\u0007".toByteArray())

        val snapshot = controller.snapshot.value
        val transcript = controller.transcriptText()
        assertTrue(transcript.contains("ready"))
        assertFalse(transcript.contains("[31m"))
        assertFalse(transcript.contains("]0;"))
        assertEquals("remote host", snapshot.title)
    }

    @Test
    fun `keeps split osc string terminator in the termux parser`() {
        val controller = SshTerminalController(scope, {}, initialCols = 40, initialRows = 4)

        controller.write("\u001b]0;split".toByteArray())
        controller.write(" title\u001b\\".toByteArray())

        assertEquals("split title", controller.snapshot.value.title)
        assertFalse(controller.transcriptText().contains("split title"))
    }

    @Test
    fun `routes vt device status replies back to the ssh channel`() {
        val replies = mutableListOf<ByteArray>()
        val controller = SshTerminalController(scope, { replies += it }, initialCols = 20, initialRows = 4)

        controller.write("\u001b[6n".toByteArray())

        assertTrue(replies.any { it.toString(Charsets.UTF_8).matches("\u001b\\[\\d+;\\d+R".toRegex()) })
    }

    @Test
    fun `keeps split utf8 resizes and routes input back to ssh`() = runBlocking {
        val sent = mutableListOf<ByteArray>()
        val controller = SshTerminalController(scope, { sent += it }, initialCols = 12, initialRows = 3)
        val bytes = "\u4e2d\u6587".toByteArray()

        controller.write(bytes.copyOfRange(0, 1))
        controller.write(bytes.copyOfRange(1, bytes.size))
        controller.resize(24, 6)
        controller.sendInput("ls\n".toByteArray())

        assertTrue(controller.transcriptText().contains("\u4e2d\u6587"))
        assertEquals(24, controller.snapshot.value.cols)
        assertEquals(6, controller.snapshot.value.rows)
        assertEquals("ls\n", sent.single().toString(Charsets.UTF_8))
    }

    @Test
    fun `preserves wide cjk cells while wrapping at the measured width`() {
        val controller = SshTerminalController(scope, {}, initialCols = 4, initialRows = 2)

        controller.write("ab\u4e2dcd".toByteArray())

        val visible = controller.visibleText()
        assertTrue(visible.contains("ab"))
        assertTrue(visible.contains("\u4e2d"))
        assertTrue(visible.contains("cd"))
        assertFalse(visible.contains("\ufffd"))
    }

    @Test
    fun `clear drops scrollback and screen content`() {
        val controller = SshTerminalController(scope, {}, initialCols = 20, initialRows = 3)
        controller.write("line one\nline two\nline three\noutput to clear".toByteArray())

        controller.clearScreen()

        assertFalse(controller.transcriptText().contains("output to clear"))
        assertFalse(controller.transcriptText().contains("line one"))
    }

    @Test
    fun `does not publish a redraw for an unchanged resize`() = runBlocking {
        val controller = SshTerminalController(scope, {}, initialCols = 20, initialRows = 3)
        val revision = controller.snapshot.value.renderRevision

        controller.resize(20, 3)

        assertEquals(revision, controller.snapshot.value.renderRevision)
    }

    @Test
    fun `applies configured font size and cursor style to the emulator`() {
        val controller = SshTerminalController(scope, {})

        controller.setFontSize(100)
        controller.setCursorStyle(TerminalCursorStyle.UNDERLINE)

        assertEquals(32, controller.requestedFontSizeSp())
        assertEquals(TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE, controller.emulator.cursorStyle)
    }
}
