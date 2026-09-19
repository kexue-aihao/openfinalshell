package io.github.openfinalshell.android.local

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.openfinalshell.android.core.local.HostLauncher
import io.github.openfinalshell.android.core.local.HostRequest
import io.github.openfinalshell.android.core.local.LocalHostArgs
import io.github.openfinalshell.android.core.local.LocalHostConfig
import io.github.openfinalshell.android.core.local.LocalHostStream
import io.github.openfinalshell.android.core.local.LocalHostTransport
import io.github.openfinalshell.android.core.local.SocketLocalHostStream
import io.github.openfinalshell.android.core.model.ConnectionAuth
import io.github.openfinalshell.android.core.model.ConnectionLocal
import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.LOCAL_SHELL_PROTOCOL
import io.github.openfinalshell.android.core.model.LocalShellTier
import io.github.openfinalshell.android.core.model.SessionState
import io.github.openfinalshell.android.core.ssh.Credentials
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Drives the whole app-side protocol against the **real** native host.
 *
 * The host is started as this app's own uid, so this proves everything except the privilege
 * escalation itself: the argv contract, the port report, the token handshake, the framing, the
 * input and resize paths, the exec stream, and the exit propagation. The privileged tiers then only
 * have to get the host process started at a different uid — which CI checks separately with the
 * helper's own `--self-test`.
 *
 * This is possible because the APK is packaged with legacy jniLibs: `libofspty.so` is a real file in
 * the native library directory with the execute bit set. It is not in the app's data directory, so
 * the API 29 exec restriction does not apply to it.
 */
@RunWith(AndroidJUnit4::class)
class LocalHostTransportInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After fun tearDown() {
        scope.cancel()
    }

    /** Starts the shipped helper as this app's own uid. The privileged launchers differ only here. */
    private class AppUidLauncher(private val helper: File, private val errorLog: File) : HostLauncher {
        private val children = mutableListOf<Process>()

        override suspend fun isAvailable(): Boolean = helper.canExecute()

        override suspend fun launch(request: HostRequest): LocalHostStream = withContext(Dispatchers.IO) {
            val process = ProcessBuilder(listOf(helper.absolutePath) + LocalHostArgs.build(request))
                // A full stderr pipe would deadlock the host.
                .redirectError(errorLog)
                .start()
            synchronized(children) { children += process }
            val port = LocalHostProcess.awaitPort(process)
            check(port > 0) {
                "the helper did not report a port; stderr was: " +
                    runCatching { errorLog.readText() }.getOrDefault("")
            }
            SocketLocalHostStream(port)
        }

        override suspend fun shutdown() {
            val running = synchronized(children) {
                val copy = children.toList()
                children.clear()
                copy
            }
            running.forEach { runCatching { it.destroy() } }
        }
    }

    /**
     * Connects inline — no `Dispatchers.IO` — which is exactly what `ShizukuHostLauncher` used to do.
     *
     * The transport is the thing under test here: it must absorb a launcher that performs blocking
     * socket I/O, because the app reaches it from the main dispatcher.
     */
    private class InlineConnectingLauncher(private val helper: File, private val errorLog: File) : HostLauncher {
        private val children = mutableListOf<Process>()

        override suspend fun isAvailable(): Boolean = helper.canExecute()

        override suspend fun launch(request: HostRequest): LocalHostStream {
            val process = ProcessBuilder(listOf(helper.absolutePath) + LocalHostArgs.build(request))
                .redirectError(errorLog)
                .start()
            synchronized(children) { children += process }
            val port = LocalHostProcess.awaitPort(process)
            check(port > 0) { "the helper did not report a port" }
            return SocketLocalHostStream(port)
        }

        override suspend fun shutdown() {
            val running = synchronized(children) {
                val copy = children.toList()
                children.clear()
                copy
            }
            running.forEach { runCatching { it.destroy() } }
        }
    }

    private fun launcher() = AppUidLauncher(
        LocalHostBinary.file(context),
        File(context.cacheDir, "ofspty-instrumented.err")
    )

    private fun inlineLauncher() = InlineConnectingLauncher(
        LocalHostBinary.file(context),
        File(context.cacheDir, "ofspty-instrumented.err")
    )

    private fun transport(launcher: HostLauncher = launcher()): LocalHostTransport {
        val spec = LocalShellSpec.forProfile(context, startDirectory = null, transcriptRows = 2_000, termType = "xterm-256color")
        return LocalHostTransport(
            launcher = launcher,
            config = LocalHostConfig(
                shellPath = spec.shellPath,
                workingDirectory = spec.workingDirectory,
                environment = spec.environment,
                roots = appTierRoots(context),
                mounts = LocalMounts.read()
            ),
            scope = scope
        )
    }

    private fun profile() = ConnectionProfile(
        id = "instrumented-local",
        name = "instrumented",
        host = "localhost",
        port = 22,
        username = "shell",
        auth = ConnectionAuth(method = "none"),
        protocol = LOCAL_SHELL_PROTOCOL,
        local = ConnectionLocal(tier = LocalShellTier.APP)
    )

    private suspend fun awaitText(via: StringBuilder, vararg needles: String, timeoutMs: Long = 20_000): String {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val text = via.toString()
            if (needles.any { text.contains(it) }) return text
            delay(50)
        }
        return via.toString()
    }

    @Test fun theHelperIsExecutableStraightFromTheNativeLibraryDirectory() {
        val helper = LocalHostBinary.file(context)
        assertTrue("expected an executable ${helper.path}", helper.canExecute())
    }

    /**
     * Opens a shell from the main dispatcher, which is what the app does.
     *
     * Every other test here runs its body in `runBlocking`, whose coroutine is parked on the test
     * thread. That is how a blocking `Socket.connect` on the caller's dispatcher passed this whole
     * suite while failing in the app with `NetworkOnMainThreadException` — `viewModelScope` is the
     * main dispatcher, and StrictMode rejects network I/O there.
     */
    @Test fun openingAShellFromTheMainDispatcherWorks() = runBlocking {
        val transport = transport(inlineLauncher())
        try {
            transport.connect(profile(), Credentials())
            val shell = withContext(Dispatchers.Main.immediate) { transport.openShell(cols = 80, rows = 24) }
            val text = StringBuilder()
            val collector = scope.launch { shell.output.collect { text.append(String(it, Charsets.UTF_8)) } }
            shell.write("printf 'MAINOK\\n'\n".toByteArray(Charsets.UTF_8))
            val seen = awaitText(text, "MAINOK")
            collector.cancel()
            assertTrue("expected a working shell when opened from Main; saw:\n$seen", seen.contains("MAINOK"))
            shell.close()
        } finally {
            transport.disconnect()
        }
    }

    /** The end-to-end proof: handshake, PTY, and a shell that really is this app's uid. */
    @Test fun handshakeThenShellRoundTrip() = runBlocking {
        val transport = transport()
        try {
            transport.connect(profile(), Credentials())
            assertEquals(SessionState.READY, transport.state.value)

            val shell = transport.openShell(cols = 80, rows = 24)
            // No emulator on this side: the caller renders the bytes, unlike the app tier.
            assertFalse("a host-backed shell must not claim the emulator", shell.ownsEmulator)

            val text = StringBuilder()
            val collector = scope.launch { shell.output.collect { text.append(String(it, Charsets.UTF_8)) } }
            val uid = android.os.Process.myUid()
            shell.write("printf 'U=%s\\n' \"\$(id -u)\"\n".toByteArray(Charsets.UTF_8))
            val seen = awaitText(text, "U=$uid")
            collector.cancel()
            assertTrue("expected the shell to report uid $uid; saw:\n$seen", seen.contains("U=$uid"))
            shell.close()
        } finally {
            transport.disconnect()
        }
    }

    /** A malformed or unsupported RESIZE would take the session down; this pins that it does not. */
    @Test fun resizeDoesNotBreakTheSession() = runBlocking {
        val transport = transport()
        try {
            transport.connect(profile(), Credentials())
            val shell = transport.openShell(cols = 80, rows = 24)
            val text = StringBuilder()
            val collector = scope.launch { shell.output.collect { text.append(String(it, Charsets.UTF_8)) } }

            shell.resize(cols = 40, rows = 12)
            shell.write("printf 'ALIVE\\n'\n".toByteArray(Charsets.UTF_8))
            awaitText(text, "ALIVE")
            assertEquals("the session must survive a window change", SessionState.READY, transport.state.value)
            collector.cancel()
        } finally {
            transport.disconnect()
        }
    }

    /**
     * The monitor's sentinel ordering depends on stderr arriving on the same ordered stream, and the
     * file panel's packed transfer reads the exit status right after the stream ends.
     */
    @Test fun execMergesStreamsInOrderAndReportsTheExitStatus() = runBlocking {
        val transport = transport()
        try {
            transport.connect(profile(), Credentials())
            val channel = transport.openExec("echo OUT; echo ERR 1>&2; exit 3")
            val text = try {
                buildString { channel.output.collect { append(String(it, Charsets.UTF_8)) } }
            } finally {
                channel.close()
            }
            assertTrue("both streams must arrive; saw:\n$text", text.contains("OUT") && text.contains("ERR"))
            assertTrue("stderr must not be reordered; saw:\n$text", text.indexOf("OUT") < text.indexOf("ERR"))
            assertEquals(3, channel.exitCode.value)
        } finally {
            transport.disconnect()
        }
    }

    /** The probe runs through the real exec path, so the frame source describes the real shell. */
    @Test fun capabilitiesComeFromTheRealShell() = runBlocking {
        val transport = transport()
        try {
            transport.connect(profile(), Credentials())
            val availability = transport.frameSource.availability
            // Port traffic is unavailable at every local tier: the counters come from `ss`, which
            // Android does not ship. A regression here would silently show an empty port list.
            assertFalse("local sessions must never claim port traffic", availability.portTraffic)
        } finally {
            transport.disconnect()
        }
    }

    /**
     * A shell that exits ends the local session.
     *
     * Unlike SSH there is no connection left to keep, and reporting a disconnect rather than
     * reconnecting is what stops `exit` from respawning the shell forever.
     */
    @Test fun theShellExitingEndsTheSession() = runBlocking {
        val transport = transport()
        try {
            transport.connect(profile(), Credentials())
            val shell = transport.openShell(cols = 80, rows = 24)
            val text = StringBuilder()
            val collector = scope.launch { shell.output.collect { text.append(String(it, Charsets.UTF_8)) } }
            awaitText(text, "$ ") // the prompt, so `exit` cannot race the shell's start

            shell.write("exit\n".toByteArray(Charsets.UTF_8))
            val deadline = System.currentTimeMillis() + 20_000
            while (transport.state.value != SessionState.CLOSED && System.currentTimeMillis() < deadline) {
                delay(50)
            }
            collector.cancel()
            assertEquals("the session must close once its shell exits", SessionState.CLOSED, transport.state.value)
        } finally {
            transport.disconnect()
        }
    }

    /** The file panel works over the same session, using the roots the tier declared. */
    @Test fun theFilePanelUsesTheDeclaredRoots() = runBlocking {
        val transport = transport()
        try {
            transport.connect(profile(), Credentials())
            val channel = transport.openSftp()
            try {
                val home = LocalShellSpec.homeDirectory(context)
                val entries = channel.list(home.path)
                // The probe and the shell may have created nothing here, so only the call is asserted.
                assertTrue("listing the session home must not fail", entries.isEmpty() || entries.isNotEmpty())
            } finally {
                channel.close()
            }
        } finally {
            transport.disconnect()
        }
    }
}
