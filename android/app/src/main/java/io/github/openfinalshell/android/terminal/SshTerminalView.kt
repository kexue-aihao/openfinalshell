package io.github.openfinalshell.android.terminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.text.InputType
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import com.termux.terminal.KeyHandler
import com.termux.terminal.TerminalEmulator
import com.termux.view.TerminalRenderer
import io.github.openfinalshell.android.R
import io.github.openfinalshell.android.core.terminal.TerminalCursorStyle
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt

internal data class TerminalViewport(val columns: Int, val rows: Int)

/** Converts measured pixels into a stable PTY viewport, preserving cell boundaries. */
internal fun measureTerminalViewport(
    width: Int,
    height: Int,
    fontWidth: Float,
    lineSpacing: Int,
    paddingLeft: Int = 0,
    paddingTop: Int = 0,
    paddingRight: Int = 0,
    paddingBottom: Int = 0,
    minColumns: Int = 4,
    minRows: Int = 4
): TerminalViewport? {
    val contentWidth = (width - paddingLeft - paddingRight).coerceAtLeast(0)
    val contentHeight = (height - paddingTop - paddingBottom).coerceAtLeast(0)
    if (contentWidth == 0 || contentHeight == 0 || !fontWidth.isFinite() || fontWidth <= 0f) return null
    val spacing = lineSpacing.coerceAtLeast(1)
    return TerminalViewport(
        columns = max(minColumns.coerceAtLeast(1), floor(contentWidth / fontWidth).toInt()),
        rows = max(minRows.coerceAtLeast(1), contentHeight / spacing)
    )
}

/**
 * A remote-shell adapter around Termux's TerminalEmulator/TerminalRenderer pair. It deliberately
 * has no local PTY: every input byte is routed to the SSH shell supplied by [onInput].
 */
class SshTerminalView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {
    private var controller: SshTerminalController? = null
    private var onInput: ((ByteArray) -> Unit)? = null
    private var onResize: ((Int, Int) -> Unit)? = null
    private var renderer = TerminalRenderer(DEFAULT_FONT_SIZE, Typeface.MONOSPACE)
    private var rendererTextSizePx = DEFAULT_FONT_SIZE
    private var topRow = 0
    private var dragStartY = 0f
    private var startTopRow = 0
    private var movedDuringGesture = false
    private var lastMeasuredColumns = -1
    private var lastMeasuredRows = -1
    private var selectionStart: TerminalCell? = null
    private var selectionEnd: TerminalCell? = null

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent): Boolean = true

        override fun onSingleTapUp(event: MotionEvent): Boolean {
            requestFocus()
            context.getSystemService(InputMethodManager::class.java)?.showSoftInput(this@SshTerminalView, InputMethodManager.SHOW_IMPLICIT)
            return true
        }

        override fun onLongPress(event: MotionEvent) {
            startSelection(event)
        }
    })

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        setBackgroundColor(Color.BLACK)
        contentDescription = null
    }

    fun bind(
        nextController: SshTerminalController,
        fontSizeSp: Int,
        cursorStyle: TerminalCursorStyle,
        input: (ByteArray) -> Unit,
        resize: (Int, Int) -> Unit
    ) {
        if (controller !== nextController) {
            lastMeasuredColumns = -1
            lastMeasuredRows = -1
            topRow = 0
            selectionStart = null
            selectionEnd = null
        }
        controller = nextController
        onInput = input
        onResize = resize
        nextController.setFontSize(fontSizeSp)
        nextController.setCursorStyle(cursorStyle)
        val scaledDensity = resources.displayMetrics.density * resources.configuration.fontScale
        val requestedSizePx = (nextController.requestedFontSizeSp() * scaledDensity)
            .roundToInt()
        if (requestedSizePx != rendererTextSizePx) {
            rendererTextSizePx = requestedSizePx
            renderer = TerminalRenderer(requestedSizePx, Typeface.MONOSPACE)
            // Font metrics determine the number of cells in the measured viewport.
            lastMeasuredColumns = -1
            lastMeasuredRows = -1
        }
        updateTerminalSize()
        invalidate()
    }

    fun refresh() = invalidate()

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val terminal = controller?.emulator ?: return
        val start = selectionStart
        val end = selectionEnd
        synchronized(terminal) {
            // A clear or resize can shrink the available transcript while a gesture is active.
            // Keep the renderer and hit testing within Termux's external row range.
            topRow = topRow.coerceIn(-terminal.screen.activeTranscriptRows, 0)
            renderer.render(
                terminal,
                canvas,
                topRow,
                start?.column ?: -1,
                start?.row ?: -1,
                end?.column ?: -1,
                end?.row ?: -1
            )
        }
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        updateTerminalSize()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        updateTerminalSize()
    }

    override fun onDetachedFromWindow() {
        // The controller owns the emulator buffer; only release view callbacks to avoid keeping
        // a disconnected Compose/ViewModel graph alive across navigation or configuration changes.
        onInput = null
        onResize = null
        lastMeasuredColumns = -1
        lastMeasuredRows = -1
        selectionStart = null
        selectionEnd = null
        super.onDetachedFromWindow()
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        return object : BaseInputConnection(this@SshTerminalView, false) {
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                dispatch(text?.toString())
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                if (beforeLength > 0) dispatch("\u007f".repeat(beforeLength))
                return true
            }

            override fun sendKeyEvent(event: KeyEvent): Boolean = handleTerminalKey(event)
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (handleTerminalKey(event)) return true
        return super.onKeyDown(keyCode, event)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        gestures.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragStartY = event.y
                startTopRow = topRow
                movedDuringGesture = false
            }
            MotionEvent.ACTION_MOVE -> {
                if (selectionStart != null) {
                    selectionEnd = cellAt(event)
                    invalidate()
                } else {
                    val lineSpacing = renderer.getFontLineSpacing().coerceAtLeast(1)
                    val rowDelta = ((event.y - dragStartY) / lineSpacing).roundToInt()
                    if (abs(event.y - dragStartY) > lineSpacing / 2f) {
                        movedDuringGesture = true
                        topRow = (startTopRow + rowDelta).coerceIn(-activeTranscriptRows(), 0)
                        invalidate()
                    }
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (selectionStart != null) finishSelection()
                else if (!movedDuringGesture) performClick()
            }
        }
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        requestFocus()
        context.getSystemService(InputMethodManager::class.java)?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
        return true
    }

    private fun handleTerminalKey(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN) return true
        val terminal = controller?.emulator ?: return false
        synchronized(terminal) {
            val modifiers = buildKeyModifiers(event)
            KeyHandler.getCode(
                event.keyCode,
                modifiers,
                terminal.isCursorKeysApplicationMode,
                terminal.isKeypadApplicationMode
            )?.let {
                dispatch(it)
                return true
            }
        }
        if (event.unicodeChar != 0) {
            dispatch(String(Character.toChars(event.unicodeChar)))
            return true
        }
        return false
    }

    private fun buildKeyModifiers(event: KeyEvent): Int {
        var modifiers = 0
        if (event.isCtrlPressed) modifiers = modifiers or KeyHandler.KEYMOD_CTRL
        if (event.isAltPressed) modifiers = modifiers or KeyHandler.KEYMOD_ALT
        if (event.isShiftPressed) modifiers = modifiers or KeyHandler.KEYMOD_SHIFT
        return modifiers
    }

    private fun updateTerminalSize() {
        val terminal = controller?.emulator ?: return
        if (width == 0 || height == 0) return
        val fontWidth = renderer.getFontWidth().takeIf { it.isFinite() && it > 0f } ?: return
        val viewport = measureTerminalViewport(
            width = width,
            height = height,
            fontWidth = fontWidth,
            lineSpacing = renderer.getFontLineSpacing(),
            paddingLeft = paddingLeft,
            paddingTop = paddingTop,
            paddingRight = paddingRight,
            paddingBottom = paddingBottom,
            minColumns = MIN_COLUMNS,
            minRows = MIN_ROWS
        ) ?: return
        if (viewport.columns != lastMeasuredColumns || viewport.rows != lastMeasuredRows) {
            lastMeasuredColumns = viewport.columns
            lastMeasuredRows = viewport.rows
            onResize?.invoke(viewport.columns, viewport.rows)
        }
    }

    private fun activeTranscriptRows(): Int {
        val terminal = controller?.emulator ?: return 0
        return activeTranscriptRows(terminal)
    }

    private fun activeTranscriptRows(terminal: TerminalEmulator): Int =
        synchronized(terminal) { terminal.screen.activeTranscriptRows }

    private fun startSelection(event: MotionEvent) {
        selectionStart = cellAt(event)
        selectionEnd = selectionStart
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        invalidate()
    }

    private fun finishSelection() {
        val start = selectionStart
        val end = selectionEnd
        selectionStart = null
        selectionEnd = null
        if (start == null || end == null) return
        val first = minOf(start, end)
        val last = maxOf(start, end)
        val terminal = controller?.emulator ?: return
        val text = synchronized(terminal) {
            terminal.getSelectedText(
                first.column,
                first.row,
                (last.column + 1).coerceAtMost(terminal.mColumns),
                last.row.coerceAtMost(terminal.mRows - 1)
            )
        }
        if (text.isBlank()) return
        context.getSystemService(ClipboardManager::class.java)
            ?.setPrimaryClip(ClipData.newPlainText(context.getString(R.string.terminal_clipboard_label), text))
        invalidate()
    }

    private fun cellAt(event: MotionEvent): TerminalCell {
        val fontWidth = renderer.getFontWidth().takeIf { it.isFinite() && it > 0f } ?: 1f
        val lineSpacing = renderer.getFontLineSpacing().coerceAtLeast(1)
        val terminal = controller?.emulator ?: return TerminalCell(0, 0)
        return synchronized(terminal) {
            val columns = terminal.mColumns
            val rows = terminal.mRows
            val column = (event.x / fontWidth).toInt().coerceIn(0, columns - 1)
            val row = (topRow + event.y.div(lineSpacing).toInt())
                .coerceIn(-terminal.screen.activeTranscriptRows, rows - 1)
            TerminalCell(column, row)
        }
    }

    private fun dispatch(text: String?) {
        if (!text.isNullOrEmpty()) onInput?.invoke(text.toByteArray(Charsets.UTF_8))
    }

    private companion object {
        const val DEFAULT_FONT_SIZE = 14
        const val MIN_FONT_SIZE = 10
        const val MAX_FONT_SIZE = 32
        const val MIN_COLUMNS = 4
        const val MIN_ROWS = 4
    }

    private data class TerminalCell(val column: Int, val row: Int) : Comparable<TerminalCell> {
        override fun compareTo(other: TerminalCell): Int =
            if (row != other.row) row.compareTo(other.row) else column.compareTo(other.column)
    }
}
