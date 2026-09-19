package io.github.openfinalshell.android.terminal

import com.termux.terminal.TerminalEmulator
import io.github.openfinalshell.android.core.terminal.TerminalController

/**
 * What [SshTerminalView] needs from whichever backend is driving it.
 *
 * This exists because the renderer draws a Termux `TerminalEmulator` directly, and `:core` has no
 * Termux dependency, so the emulator accessor cannot live on [TerminalController] itself. An SSH
 * session and a local on-device shell therefore both present the renderer with the same pair: an
 * emulator to draw, and the font size the user asked for.
 *
 * The two implementations answer [emulator] very differently, and that difference is the whole
 * reason [io.github.openfinalshell.android.core.ssh.ShellChannel.ownsEmulator] exists:
 * - [SshTerminalController] creates the emulator and appends every byte the channel emits.
 * - [LocalTerminalController] delegates to a Termux `TerminalSession`, which owns both the PTY and
 *   the emulator and appends its own bytes. Feeding it through a controller as well would render
 *   every line twice.
 */
interface TerminalHostController : TerminalController {
    /**
     * The emulator to draw, or null before the backend has started one. Every consumer in
     * [SshTerminalView] already treats null as "nothing to draw yet", and a local session genuinely
     * has such a window between construction and the PTY coming up.
     */
    val emulator: TerminalEmulator?

    /** The validated font size the renderer should recreate itself with. */
    fun requestedFontSizeSp(): Int
}
