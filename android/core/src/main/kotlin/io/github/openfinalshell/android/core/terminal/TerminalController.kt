package io.github.openfinalshell.android.core.terminal

import kotlinx.coroutines.flow.StateFlow

/**
 * Boundary between an SSH shell and the Android terminal renderer. Implementations own only
 * terminal presentation state: callers retain ownership of the SSH session and its lifecycle.
 */
interface TerminalController {
    val snapshot: StateFlow<TerminalSnapshot>

    fun write(data: ByteArray)
    suspend fun sendInput(data: ByteArray)
    suspend fun resize(cols: Int, rows: Int)
    fun clearScreen()
    fun setFontSize(size: Int)
    fun setCursorStyle(style: TerminalCursorStyle)

    /** Release renderer-side resources without closing the SSH shell. */
    fun disposeView()

    /** Release terminal state after its SSH shell has been closed. */
    suspend fun closeSession()
}

enum class TerminalCursorStyle {
    BLOCK,
    BAR,
    UNDERLINE
}

data class TerminalSnapshot(
    /** Changes whenever the renderer must redraw; it never carries terminal transcript data. */
    val renderRevision: Long = 0,
    val cols: Int = 80,
    val rows: Int = 24,
    val cursorColumn: Int = 0,
    val cursorRow: Int = 0,
    val title: String? = null
)
