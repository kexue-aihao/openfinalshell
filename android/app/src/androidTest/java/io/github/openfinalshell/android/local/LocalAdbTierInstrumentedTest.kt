package io.github.openfinalshell.android.local

import android.content.pm.PackageManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.openfinalshell.android.core.local.LocalHostConfig
import io.github.openfinalshell.android.core.local.LocalHostTransport
import io.github.openfinalshell.android.core.model.ConnectionAuth
import io.github.openfinalshell.android.core.model.ConnectionLocal
import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.LOCAL_SHELL_PROTOCOL
import io.github.openfinalshell.android.core.model.LocalShellTier
import io.github.openfinalshell.android.core.model.SessionState
import io.github.openfinalshell.android.core.ssh.Credentials
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import rikka.shizuku.Shizuku

/**
 * The ADB-shell tier, end to end, through Shizuku.
 *
 * Everything else about this tier is verified without Shizuku — the helper's PTY allocation by
 * `--self-test`, and the app-side protocol by driving the real helper. What only this test covers is
 * the middle: the user-service binding, the AIDL call, the service copying and executing the helper
 * at uid 2000, and the app connecting to a host that is *not* its own process.
 *
 * Skipped unless Shizuku is installed, running and granted to this app:
 *   adb shell <shizuku-starter>            # from Shizuku's "Start by connecting to a computer"
 *   adb shell pm grant io.github.openfinalshell.android moe.shizuku.manager.permission.API_V23
 */
@RunWith(AndroidJUnit4::class)
class LocalAdbTierInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val launcher by lazy { ShizukuHostLauncher(context) }

    @After fun tearDown() {
        scope.cancel()
    }

    private fun shizukuReady(): Boolean = runCatching {
        Shizuku.pingBinder() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)

    private fun profile() = ConnectionProfile(
        id = "adb-tier",
        name = "adb tier",
        host = "localhost",
        port = 22,
        username = "shell",
        auth = ConnectionAuth(method = "none"),
        protocol = LOCAL_SHELL_PROTOCOL,
        local = ConnectionLocal(tier = LocalShellTier.ADB)
    )

    private fun transport(): LocalHostTransport {
        val spec = LocalShellSpec.forProfile(context, startDirectory = null, transcriptRows = 2_000, termType = "xterm-256color")
        return LocalHostTransport(
            launcher = launcher,
            config = LocalHostConfig(
                shellPath = spec.shellPath,
                // The shell tier owns /data/local/tmp, which is also where the service stages itself.
                workingDirectory = "/data/local/tmp",
                environment = spec.environment,
                roots = privilegedTierRoots(LocalTier.ADB),
                mounts = LocalMounts.read()
            ),
            scope = scope
        )
    }

    private suspend fun awaitText(via: StringBuilder, needle: String, timeoutMs: Long = 30_000): String {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (via.contains(needle)) break
            delay(50)
        }
        return via.toString()
    }

    /**
     * The whole point of the tier: a shell that is not the app.
     *
     * `uid=2000` is the assertion that matters. A binding that silently fell back to the app's own
     * process would still produce a working shell, and would still pass every other test here.
     */
    @Test fun theShellRunsAtTheAdbUidNotTheAppsOwn() = runBlocking<Unit> {
        assumeTrue("Shizuku is not running, or this app is not granted", shizukuReady())
        val transport = transport()
        try {
            transport.connect(profile(), Credentials())
            assertEquals(SessionState.READY, transport.state.value)
            val shell = transport.openShell(cols = 80, rows = 24)

            val text = StringBuilder()
            val collector = scope.launch { shell.output.collect { text.append(String(it, Charsets.UTF_8)) } }
            shell.write("printf 'UID=%s\\n' \"\$(id -u)\"\n".toByteArray(Charsets.UTF_8))
            val seen = awaitText(text, "UID=")
            collector.cancel()

            assertTrue("expected the shell uid; saw:\n$seen", seen.contains("UID=2000"))
            assertTrue(
                "the shell must not be running as this app (uid ${android.os.Process.myUid()}); saw:\n$seen",
                !seen.contains("UID=${android.os.Process.myUid()}")
            )
            shell.close()
        } finally {
            transport.disconnect()
        }
    }

    /** The tier's other advertised capability: shared storage that the app uid cannot reach. */
    @Test fun theFilePanelReachesSharedStorageAtTheAdbTier() = runBlocking<Unit> {
        assumeTrue("Shizuku is not running, or this app is not granted", shizukuReady())
        val transport = transport()
        try {
            transport.connect(profile(), Credentials())
            val channel = transport.openSftp()
            try {
                // Listing /sdcard is exactly what the app tier cannot do without all-files access.
                val entries = channel.list("/sdcard")
                assertTrue("expected /sdcard to list at the shell uid", entries.isNotEmpty())
                assertTrue(
                    "expected ordinary shared-storage entries; saw ${entries.map { it.name }.take(5)}",
                    entries.any { it.name == "Android" } || entries.any { it.type.name == "DIRECTORY" }
                )
            } finally {
                channel.close()
            }
        } finally {
            transport.disconnect()
        }
    }

    /** The probe runs as the shell uid too, so it sees more of `/proc` than the app tier does. */
    @Test fun theMonitorProbeReflectsTheShellUid() = runBlocking<Unit> {
        assumeTrue("Shizuku is not running, or this app is not granted", shizukuReady())
        val transport = transport()
        try {
            transport.connect(profile(), Credentials())
            val availability = transport.frameSource.availability
            assertEquals("the connection must be ready", SessionState.READY, transport.state.value)
            // `/proc/net/tcp` is denied to an app-uid process; at the shell uid it is readable, so the
            // TCP state section becomes available. This is the tier's most visible monitor difference.
            assertTrue("expected TCP states to be collectable at the shell uid", availability.tcpStates)
        } finally {
            transport.disconnect()
        }
    }

    /** Exposed so a failure can be read without a device: the uid Shizuku is actually running as. */
    @Test fun shizukuReportsWhichUidTheUserServiceWillHave() = runBlocking<Unit> {
        assumeTrue("Shizuku is not running", runCatching { Shizuku.pingBinder() }.getOrDefault(false))
        val uid = Shizuku.getUid()
        // 2000 for an adb-started Shizuku, 0 when Shizuku itself runs as root through Sui.
        assertTrue("unexpected Shizuku uid $uid", uid == 0 || uid == 2000)
    }
}
