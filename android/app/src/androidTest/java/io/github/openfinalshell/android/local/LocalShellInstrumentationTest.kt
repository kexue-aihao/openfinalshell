package io.github.openfinalshell.android.local

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.openfinalshell.android.core.local.LocalDeleteRefusal
import io.github.openfinalshell.android.core.local.LocalFileChannel
import io.github.openfinalshell.android.core.local.LocalRoots
import io.github.openfinalshell.android.core.local.UnsafeLocalDelete
import io.github.openfinalshell.android.core.monitor.LocalCapabilityProbe
import io.github.openfinalshell.android.core.monitor.LocalMonitorFrameSource
import io.github.openfinalshell.android.terminal.LocalTerminalController
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Verifies the app-tier local shell against the real Android runtime.
 *
 * These are the claims an emulator can settle and a unit test cannot: that the PTY really starts as
 * the app's own uid, that its bytes reach the emulator exactly once, that a resize reaches the
 * kernel, and that the delete guard refuses system paths before any I/O.
 */
@RunWith(AndroidJUnit4::class)
class LocalShellInstrumentationTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun spec() = LocalShellSpec.forProfile(context, startDirectory = null, transcriptRows = 2_000, termType = "xterm-256color")

    private fun startController(cols: Int = 80, rows: Int = 24): LocalTerminalController {
        val spec = spec()
        // start() dispatches to the main thread itself, which is what lets a test thread call it.
        return runBlocking {
            LocalTerminalController.start(
                shellPath = spec.shellPath,
                cwd = spec.workingDirectory,
                args = arrayOf(spec.shellPath),
                env = spec.environment,
                transcriptRows = spec.transcriptRows,
                cols = cols,
                rows = rows
            )
        }
    }

    /**
     * Pins what the app tier actually declares, because the guard's ownership carve-out is only as
     * good as this list: an empty `owned` silently makes the session unable to manage its own files.
     */
    @Test fun appTierRootsOwnThePrivateDirectories() {
        val roots = appTierRoots(context)
        assertTrue("owned was empty; the session could not delete its own files", roots.owned.isNotEmpty())
        val filesDir = context.filesDir.path
        assertTrue(
            "filesDir $filesDir is not covered by owned ${roots.owned}",
            roots.owned.any { filesDir == it || filesDir.startsWith("$it/") }
        )
        assertTrue("filesDir must also be writable", roots.writable.any { filesDir == it || filesDir.startsWith("$it/") })
    }

    private fun send(controller: LocalTerminalController, input: String) {
        runBlocking { controller.sendInput(input.toByteArray(Charsets.UTF_8)) }
    }

    private fun awaitAny(controller: LocalTerminalController, vararg needles: String, timeoutMs: Long = 20_000): String {
        val deadline = System.currentTimeMillis() + timeoutMs
        var text = ""
        while (System.currentTimeMillis() < deadline) {
            text = controller.transcriptText()
            if (needles.any { text.contains(it) }) return text
            Thread.sleep(50)
        }
        fail("timed out waiting for ${needles.toList()}; transcript was:\n$text")
        return text
    }

    private fun stop(controller: LocalTerminalController) {
        runBlocking { controller.closeSession() }
    }

    /**
     * The packaging enabler, asserted directly rather than inferred from the APK layout: with
     * `extractNativeLibs="false"` no file exists at this path at all, and the privileged tiers could
     * never load the helper.
     */
    @Test fun nativeLibraryIsOnDiskAndLoadable() {
        val library = File(context.applicationInfo.nativeLibraryDir, "libtermux.so")
        assertTrue("expected an extracted ${library.path}; jniLibs must use legacy packaging", library.isFile)
        System.load(library.path)
    }

    /** The shell must be the app's own uid — this is what makes it the unprivileged tier. */
    @Test fun theShellRunsAsTheAppUid() {
        val controller = startController()
        try {
            val uid = android.os.Process.myUid()
            send(controller, "printf 'U=%s\\n' \"\$(id -u)\"\n")
            awaitAny(controller, "U=$uid")
        } finally {
            stop(controller)
        }
    }

    /**
     * Output must reach the emulator exactly once.
     *
     * The failure this catches is specific and easy to introduce: a local session owns both the PTY
     * and the emulator, so also running it through the SSH controller's byte pipeline renders every
     * line twice.
     */
    @Test fun shellOutputIsRenderedExactlyOnce() {
        val controller = startController()
        try {
            val uid = android.os.Process.myUid()
            send(controller, "printf 'U=%s\\n' \"\$(id -u)\"\n")
            val transcript = awaitAny(controller, "U=$uid")
            assertEquals(
                "the same output reached the emulator more than once; transcript was:\n$transcript",
                1,
                Regex("U=$uid").findAll(transcript).count()
            )
        } finally {
            stop(controller)
        }
    }

    /**
     * The half of resize that is always observable: the viewport the renderer will draw.
     *
     * This runs everywhere. The kernel half — whether TIOCSWINSZ actually reached the pty, which is
     * what full-screen programs lay out from — is [resizeReachesThePty], and it can only be asserted
     * on a device whose shell has `stty`.
     */
    @Test fun resizeUpdatesTheViewport() {
        val controller = startController(cols = 80, rows = 24)
        try {
            runBlocking { controller.resize(40, 12) }
            val snapshot = controller.snapshot.value
            assertEquals("columns must follow the requested viewport", 40, snapshot.cols)
            assertEquals("rows must follow the requested viewport", 12, snapshot.rows)
        } finally {
            stop(controller)
        }
    }

    /** A viewport change has to reach the kernel, or full-screen programs lay out for 80x24. */
    @Test fun resizeReachesThePty() {
        val controller = startController(cols = 80, rows = 24)
        try {
            runBlocking { controller.resize(40, 12) }
            send(controller, "command -v stty >/dev/null 2>&1 && stty size || echo NOSTTY\n")
            val transcript = awaitAny(controller, "12 40", "NOSTTY")
            assumeTrue("this device has no stty, so the kernel window size cannot be asserted", !transcript.contains("NOSTTY"))
            assertTrue("expected the PTY to report 12 rows by 40 columns; transcript was:\n$transcript", transcript.contains("12 40"))
        } finally {
            stop(controller)
        }
    }

    /** The probe must describe the shell it actually ran on, not the tier it was told to expect. */
    @Test fun capabilityProbeReportsTheRealShell() = runBlocking {
        val spec = spec()
        val channel = LocalExecChannel.start(spec.shellPath, LocalCapabilityProbe.probeCommand(), spec.workingDirectory, spec.environment)
        val text = try {
            buildString { channel.output.collect { append(String(it, Charsets.UTF_8)) } }
        } finally {
            channel.close()
        }
        val capabilities = LocalCapabilityProbe.parse(text)
        assertEquals("the probe must report the uid it really ran as", android.os.Process.myUid(), capabilities.uid)
        // Whatever this device exposes, the frame built from it must still be well formed.
        val frame = LocalMonitorFrameSource(capabilities).frame(1, 0)
        assertTrue(frame.startsWith("printf '%s\\n' '@@OFS:BEGIN:1@@'\n"))
        assertTrue(frame.endsWith("printf '%s\\n' '@@OFS:END:1@@'\n"))
    }

    /** stderr has to arrive on the same ordered stream; the monitor's sentinels depend on it. */
    @Test fun execChannelMergesStderrIntoOneOrderedStream() = runBlocking {
        val spec = spec()
        val channel = LocalExecChannel.start(spec.shellPath, "echo OUT; echo ERR 1>&2; exit 3", spec.workingDirectory, spec.environment)
        val text = try {
            buildString { channel.output.collect { append(String(it, Charsets.UTF_8)) } }
        } finally {
            channel.close()
        }
        assertEquals(3, channel.exitCode.value)
        assertTrue("both streams must be present; got:\n$text", text.contains("OUT") && text.contains("ERR"))
        assertTrue("stderr must not be reordered after stdout; got:\n$text", text.indexOf("OUT") < text.indexOf("ERR"))
    }

    /**
     * The same shape as the unit test that failed on Linux: a target that exists but sits outside
     * the declared writable roots.
     *
     * It lives here as well because Android's kernel is Linux, so this runs the POSIX path on every
     * device — while the JVM copy is gated to non-Windows hosts and can therefore sit unexecuted.
     * The target must exist: `delete` fails on a missing path before the guard is consulted, which is
     * precisely the mistake that hid in the gated test.
     */
    @Test fun aRefusedDeleteLeavesTheTargetAlone() = runBlocking {
        val directory = File(context.filesDir, "instrumented-refusal").apply { mkdirs() }
        val target = File(directory, "keep.txt").apply { writeBytes("keep".toByteArray()) }
        // Writable roots that deliberately exclude the directory the target lives in.
        val narrow = LocalRoots(
            readable = listOf(context.filesDir.path),
            writable = listOf(File(context.filesDir, "elsewhere").path)
        )
        val channel = LocalFileChannel(narrow)
        val error = runCatching { channel.delete(target.path, recursive = false) }.exceptionOrNull()
        assertTrue("expected a guard refusal, got $error", error is UnsafeLocalDelete)
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, (error as UnsafeLocalDelete).refusal)
        assertTrue("a refused delete must not have deleted anything", target.exists())
    }

    @Test fun fileChannelRoundTripsAndRefusesProtectedPaths() = runBlocking {
        val declared = appTierRoots(context)
        val mounts = LocalMounts.read()
        val channel = LocalFileChannel(declared, mounts)
        val directory = File(context.filesDir, "instrumented-transfer").apply { mkdirs() }
        val path = File(directory, "note.txt").path

        channel.write(path, "hello".toByteArray())
        assertArrayEquals("hello".toByteArray(), channel.read(path))
        channel.writeChunk(path, "XY".toByteArray(), offset = 1, truncate = false)
        assertArrayEquals("hXYlo".toByteArray(), channel.read(path))

        // A same-directory rename is what the editor's atomic save relies on.
        val staging = File(directory, ".ofs-edit-instrumented.tmp").apply { writeBytes("new".toByteArray()) }
        channel.atomicReplace(staging.path, path)
        assertArrayEquals("new".toByteArray(), channel.read(path))

        // Deletable inside a writable root…
        try {
            channel.delete(path, recursive = false)
        } catch (error: UnsafeLocalDelete) {
            val canonicalRoots = declared.canonicalized()
            fail(
                "delete of $path was refused as ${error.refusal}; " +
                    "canonicalPath=${runCatching { File(path).canonicalPath }.getOrNull()}; " +
                    "owned=${canonicalRoots.owned}; " +
                    "writable=${canonicalRoots.writable}; " +
                    "coveringMounts=${mounts.filter { path == it || path.startsWith("$it/") }}"
            )
        }
        assertFalse(File(path).exists())

        // …and refused everywhere the app tier must never remove from, without touching the disk.
        for (protected in listOf("/system/build.prop", "/data/data", "/proc/self/cmdline", "/storage/emulated/0")) {
            val error = runCatching { channel.delete(protected, recursive = true) }.exceptionOrNull()
            assertTrue("$protected must be refused, but got $error", error is UnsafeLocalDelete)
        }
    }
}
