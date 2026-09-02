package io.github.openfinalshell.android.terminal

import android.util.Log
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import io.github.openfinalshell.android.core.terminal.TerminalController
import io.github.openfinalshell.android.core.terminal.TerminalCursorStyle
import io.github.openfinalshell.android.core.terminal.TerminalSnapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Adapts a remote SSH channel to Termux's maintained terminal emulator. No local process or PTY
 * is created: remote bytes are appended directly, while terminal replies and user input are sent
 * back through [inputSink].
 */
class SshTerminalController(
    private val inputScope: CoroutineScope,
    private val inputSink: suspend (ByteArray) -> Unit,
    initialCols: Int = DEFAULT_COLUMNS,
    initialRows: Int = DEFAULT_ROWS,
    scrollbackLines: Int = DEFAULT_SCROLLBACK
) : TerminalController, TerminalSessionClient {
    @Volatile private var closed = false
    @Volatile private var title: String? = null
    @Volatile private var fontSizeSp = DEFAULT_FONT_SIZE
    @Volatile private var cursorStyle = TerminalEmulator.DEFAULT_TERMINAL_CURSOR_STYLE
    private var initialized = false
    private var renderRevision = 0L

    private val terminalOutput = object : TerminalOutput() {
        override fun write(data: ByteArray, offset: Int, count: Int) {
            if (closed || count <= 0) return
            val response = data.copyOfRange(offset, offset + count)
            inputScope.launch { inputSink(response) }
        }

        override fun titleChanged(oldTitle: String?, newTitle: String?) {
            title = newTitle
            publishSnapshot()
        }

        override fun onCopyTextToClipboard(text: String?) = Unit

        override fun onPasteTextFromClipboard() = Unit

        override fun onBell() = Unit

        override fun onColorsChanged() = publishSnapshot()
    }

    val emulator = TerminalEmulator(
        terminalOutput,
        initialCols.coerceAtLeast(MIN_COLUMNS),
        initialRows.coerceAtLeast(MIN_ROWS),
        scrollbackLines.coerceIn(
            TerminalEmulator.TERMINAL_TRANSCRIPT_ROWS_MIN,
            TerminalEmulator.TERMINAL_TRANSCRIPT_ROWS_MAX
        ),
        this
    )

    private val mutableSnapshot = MutableStateFlow(createSnapshot())
    override val snapshot: StateFlow<TerminalSnapshot> = mutableSnapshot.asStateFlow()

    init {
        initialized = true
    }

    override fun write(data: ByteArray) {
        if (closed || data.isEmpty()) return
        synchronized(emulator) {
            emulator.append(data, data.size)
            publishSnapshot()
        }
    }

    override suspend fun sendInput(data: ByteArray) {
        if (!closed && data.isNotEmpty()) inputSink(data)
    }

    override suspend fun resize(cols: Int, rows: Int) {
        if (closed) return
        synchronized(emulator) {
            emulator.resize(cols.coerceAtLeast(MIN_COLUMNS), rows.coerceAtLeast(MIN_ROWS))
            publishSnapshot()
        }
    }

    override fun clearScreen() {
        if (closed) return
        synchronized(emulator) {
            // Let the terminal engine apply the same clear semantics a remote `clear` command
            // would use: active screen, cursor position, and scrollback are all reset.
            val clearSequence = "\u001b[3J\u001b[2J\u001b[H".toByteArray(Charsets.UTF_8)
            emulator.append(clearSequence, clearSequence.size)
            emulator.screen.clearTranscript()
            publishSnapshot()
        }
    }

    override fun setFontSize(size: Int) {
        // Font metrics belong to TerminalRenderer. Retain the validated preference so a
        // reattached view recreates the renderer with the controller-owned configuration.
        fontSizeSp = size.coerceIn(MIN_FONT_SIZE, MAX_FONT_SIZE)
    }

    fun requestedFontSizeSp(): Int = fontSizeSp

    override fun setCursorStyle(style: TerminalCursorStyle) {
        val nextStyle = when (style) {
            TerminalCursorStyle.BLOCK -> TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK
            TerminalCursorStyle.BAR -> TerminalEmulator.TERMINAL_CURSOR_STYLE_BAR
            TerminalCursorStyle.UNDERLINE -> TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE
        }
        if (cursorStyle == nextStyle) return
        cursorStyle = nextStyle
        synchronized(emulator) {
            emulator.setCursorStyle()
            publishSnapshot()
        }
    }

    override fun disposeView() {
        // A composable leaving composition must not discard an active SSH terminal buffer.
    }

    override suspend fun closeSession() {
        closed = true
    }

    fun visibleText(topRow: Int = 0): String = synchronized(emulator) {
        emulator.getSelectedText(0, topRow, emulator.mColumns, topRow + emulator.mRows)
    }

    /** Reads transcript only for explicit copy/testing work, never as part of a Compose redraw. */
    fun transcriptText(): String = synchronized(emulator) {
        emulator.screen.transcriptTextWithoutJoinedLines.takeLast(MAX_SNAPSHOT_CHARS)
    }

    override fun onTextChanged(session: TerminalSession?) = Unit

    override fun onTitleChanged(session: TerminalSession?) {
        title = session?.title
        publishSnapshot()
    }

    override fun onSessionFinished(session: TerminalSession?) = Unit

    override fun onCopyTextToClipboard(session: TerminalSession?, text: String?) = Unit

    override fun onPasteTextFromClipboard(session: TerminalSession?) = Unit

    override fun onBell(session: TerminalSession?) = Unit

    override fun onColorsChanged(session: TerminalSession?) = publishSnapshot()

    override fun onTerminalCursorStateChange(state: Boolean) = Unit

    override fun getTerminalCursorStyle(): Int = cursorStyle

    override fun logError(tag: String?, message: String?) {
        Log.e(tag ?: LOG_TAG, message.orEmpty())
    }

    override fun logWarn(tag: String?, message: String?) {
        Log.w(tag ?: LOG_TAG, message.orEmpty())
    }

    override fun logInfo(tag: String?, message: String?) {
        Log.i(tag ?: LOG_TAG, message.orEmpty())
    }

    override fun logDebug(tag: String?, message: String?) {
        Log.d(tag ?: LOG_TAG, message.orEmpty())
    }

    override fun logVerbose(tag: String?, message: String?) {
        Log.v(tag ?: LOG_TAG, message.orEmpty())
    }

    override fun logStackTraceWithMessage(tag: String?, message: String?, error: Exception?) {
        Log.e(tag ?: LOG_TAG, message.orEmpty(), error)
    }

    override fun logStackTrace(tag: String?, error: Exception?) {
        Log.e(tag ?: LOG_TAG, error?.message.orEmpty(), error)
    }

    private fun publishSnapshot() {
        if (!initialized) return
        mutableSnapshot.value = createSnapshot()
    }

    private fun createSnapshot(): TerminalSnapshot = TerminalSnapshot(
        renderRevision = renderRevision++,
        cols = emulator.mColumns,
        rows = emulator.mRows,
        cursorColumn = emulator.cursorCol,
        cursorRow = emulator.cursorRow,
        title = title ?: emulator.title
    )

    private companion object {
        const val LOG_TAG = "SshTerminal"
        const val DEFAULT_COLUMNS = 80
        const val DEFAULT_ROWS = 24
        const val DEFAULT_SCROLLBACK = 2_000
        const val DEFAULT_FONT_SIZE = 14
        const val MIN_FONT_SIZE = 10
        const val MAX_FONT_SIZE = 32
        const val MIN_COLUMNS = 4
        const val MIN_ROWS = 4
        const val MAX_SNAPSHOT_CHARS = 200_000
    }
}
