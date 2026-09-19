package io.github.openfinalshell.android.terminal

import android.util.Log
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import io.github.openfinalshell.android.core.terminal.TerminalCursorStyle
import io.github.openfinalshell.android.core.terminal.TerminalSnapshot
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/**
 * Drives the renderer from a Termux [TerminalSession] — a shell running on this device.
 *
 * The counterpart to [SshTerminalController], and the reason that class's KDoc says it creates no
 * local PTY. Here the session owns both the PTY and the emulator, so:
 * - [emulator] hands the renderer the session's own emulator, and
 * - [write] is deliberately a **no-op**. Bytes reach the screen once, through the session's own
 *   reader thread. Appending them here as well would render every line twice.
 *
 * [SshSessionManager][io.github.openfinalshell.android.core.ssh.SshSessionManager] therefore starts
 * the collect-output job only for a channel whose `ownsEmulator` is false.
 */
class LocalTerminalController private constructor() : TerminalHostController, TerminalSessionClient {
    private lateinit var session: TerminalSession
    @Volatile private var closed = false
    @Volatile private var title: String? = null
    @Volatile private var fontSizeSp = DEFAULT_FONT_SIZE
    @Volatile private var cursorStyle = TerminalEmulator.DEFAULT_TERMINAL_CURSOR_STYLE
    private var initialized = false
    private var renderRevision = 0L

    private val mutableSnapshot = MutableStateFlow(TerminalSnapshot())
    override val snapshot: StateFlow<TerminalSnapshot> = mutableSnapshot.asStateFlow()

    /**
     * Completes once when the shell process exits.
     *
     * A deferred rather than a shared flow on purpose: a shared flow with no subscriber yet would
     * drop the event, and a shell that exits immediately (`sh -c exit`) can finish before anything
     * has had a chance to subscribe. Awaiting a deferred cannot miss it.
     */
    val finished = CompletableDeferred<Unit>()

    /** The pid of the shell, for diagnostics. -1 before the PTY starts. */
    val pid: Int get() = if (::session.isInitialized) session.pid else -1

    override val emulator: TerminalEmulator?
        get() = if (::session.isInitialized) session.emulator else null

    init {
        initialized = true
    }

    override fun write(data: ByteArray) {
        // Intentionally empty: see the class note about double rendering.
    }

    override suspend fun sendInput(data: ByteArray) {
        if (closed || data.isEmpty() || !::session.isInitialized) return
        session.write(data, 0, data.size)
    }

    override suspend fun resize(cols: Int, rows: Int) {
        if (closed || !::session.isInitialized) return
        // updateSize starts the PTY on its first call and resizes it afterwards, so the kernel
        // window size is what the renderer reports rather than a stale 80x24.
        session.updateSize(cols.coerceAtLeast(MIN_COLUMNS), rows.coerceAtLeast(MIN_ROWS))
        publishSnapshot()
    }

    override fun clearScreen() {
        val emulator = emulator ?: return
        synchronized(emulator) {
            // The same sequence a remote `clear` uses, so the visible result matches an SSH session.
            val clearSequence = "\u001b[3J\u001b[2J\u001b[H".toByteArray(Charsets.UTF_8)
            emulator.append(clearSequence, clearSequence.size)
            emulator.screen.clearTranscript()
            emulator.clearScrollCounter()
            publishSnapshot()
        }
    }

    override fun setFontSize(size: Int) {
        fontSizeSp = size.coerceIn(MIN_FONT_SIZE, MAX_FONT_SIZE)
    }

    override fun requestedFontSizeSp(): Int = fontSizeSp

    override fun setCursorStyle(style: TerminalCursorStyle) {
        cursorStyle = when (style) {
            TerminalCursorStyle.BLOCK -> TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK
            TerminalCursorStyle.BAR -> TerminalEmulator.TERMINAL_CURSOR_STYLE_BAR
            TerminalCursorStyle.UNDERLINE -> TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE
        }
    }

    override fun disposeView() {
        // A composable leaving composition must not discard a live shell's buffer.
    }

    override suspend fun closeSession() {
        closed = true
        if (::session.isInitialized) session.finishIfRunning()
    }

    /** Shell pids are reported by the transport, not here. */
    fun handle(): String? = if (::session.isInitialized) session.mHandle else null

    /** Reads the visible screen. Mirrors the SSH controller's helper; for copy and test work only. */
    fun visibleText(topRow: Int = 0): String {
        val current = emulator ?: return ""
        return synchronized(current) {
            val clamped = topRow.coerceIn(-current.screen.activeTranscriptRows, 0)
            current.getSelectedText(0, clamped, current.mColumns, clamped + current.mRows)
        }
    }

    /**
     * Reads the transcript, including scrollback. Never part of a redraw: it exists for explicit
     * copy and for tests that need to assert what the shell actually printed.
     */
    fun transcriptText(): String {
        val current = emulator ?: return ""
        return synchronized(current) { current.screen.transcriptTextWithoutJoinedLines }
    }

    override fun onTextChanged(session: TerminalSession?) = publishSnapshot()

    override fun onTitleChanged(session: TerminalSession?) {
        title = session?.title
        publishSnapshot()
    }

    override fun onSessionFinished(session: TerminalSession?) {
        closed = true
        finished.complete(Unit)
        publishSnapshot()
    }

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
        val current = emulator ?: return
        synchronized(current) {
            mutableSnapshot.value = TerminalSnapshot(
                renderRevision = renderRevision++,
                cols = current.mColumns,
                rows = current.mRows,
                cursorColumn = current.cursorCol,
                cursorRow = current.cursorRow,
                title = title ?: current.title
            )
        }
    }

    companion object {
        /**
         * Builds the controller, the session and the PTY in the only order that works.
         *
         * Three orderings are load bearing. The session needs its client at construction, so the
         * controller exists first. The emulator only exists after `updateSize`, so the renderer must
         * not be handed the controller before then. And `updateSize` invokes the client callbacks
         * synchronously, so by the time it runs everything they touch must already be initialised —
         * which is why this factory, rather than the constructor, is the entry point.
         *
         * Suspending, and dispatching to the main thread itself, because `TerminalSession` builds a
         * `Handler` for its screen-update callbacks and therefore has to be constructed on a thread
         * that has a `Looper`. Keeping that requirement here rather than at each call site means a
         * caller on a pool thread — or an instrumentation test thread — cannot get it wrong.
         */
        suspend fun start(
            shellPath: String,
            cwd: String,
            args: Array<String>,
            env: Array<String>,
            transcriptRows: Int,
            cols: Int,
            rows: Int
        ): LocalTerminalController = withContext(Dispatchers.Main.immediate) {
            val controller = LocalTerminalController()
            val transcript = transcriptRows.coerceIn(
                TerminalEmulator.TERMINAL_TRANSCRIPT_ROWS_MIN,
                TerminalEmulator.TERMINAL_TRANSCRIPT_ROWS_MAX
            )
            controller.session = TerminalSession(shellPath, cwd, args, env, transcript, controller)
            controller.session.updateSize(cols.coerceAtLeast(MIN_COLUMNS), rows.coerceAtLeast(MIN_ROWS))
            controller.publishSnapshot()
            controller
        }

        private const val LOG_TAG = "LocalTerminal"
        private const val DEFAULT_FONT_SIZE = 14
        private const val MIN_FONT_SIZE = 10
        private const val MAX_FONT_SIZE = 32
        private const val MIN_COLUMNS = 4
        private const val MIN_ROWS = 4
    }
}
