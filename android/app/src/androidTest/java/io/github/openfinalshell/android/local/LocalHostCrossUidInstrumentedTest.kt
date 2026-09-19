package io.github.openfinalshell.android.local

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.openfinalshell.android.core.local.LocalHostSession
import io.github.openfinalshell.android.core.local.SocketLocalHostStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Verifies the assumption the privileged tiers rest on: **an app-uid process can drive a PTY host
 * running at the shell uid over loopback.**
 *
 * That is not obvious and not guaranteed. An abstract UNIX socket would need a SELinux
 * `unix_stream_socket connectto` exemption between `shell` and `untrusted_app`, which no app can
 * grant itself — loopback TCP was chosen partly to avoid it. This test is what proves the choice
 * works rather than assuming it does.
 *
 * The host is staged outside the app, by whatever has shell access (adb, or a Shizuku user service in
 * production). It therefore also covers the port report, the token handshake and the framing across
 * a uid boundary, which is everything about L1 except the Shizuku binding itself.
 *
 * Skipped unless a host has been staged: pass `-e ofsHostPort <n> -e ofsHostToken <hex>`.
 */
@RunWith(AndroidJUnit4::class)
class LocalHostCrossUidInstrumentedTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After fun tearDown() {
        scope.cancel()
    }

    private fun stagedHost(): Pair<Int, String>? {
        val arguments = InstrumentationRegistry.getArguments()
        val port = arguments.getString("ofsHostPort")?.toIntOrNull() ?: return null
        val token = arguments.getString("ofsHostToken")?.takeIf { it.isNotBlank() } ?: return null
        return port to token
    }

    @Test fun anAppUidProcessCanDriveAShellUidHost() = runBlocking<Unit> {
        val staged = stagedHost()
        assumeTrue("no PTY host was staged for this run", staged != null)
        val (port, token) = staged!!

        val session = LocalHostSession(SocketLocalHostStream(port), scope)
        try {
            // A cross-uid connect that SELinux refused would fail here, before any protocol runs.
            session.handshake(token, timeoutMs = 10_000)

            val collected = StringBuilder()
            scope.launch { session.output.collect { collected.append(String(it, Charsets.UTF_8)) } }
            session.sendInput("printf 'UID=%s\\n' \"\$(id -u)\"\n".toByteArray(Charsets.UTF_8))

            val deadline = System.currentTimeMillis() + 15_000
            while (System.currentTimeMillis() < deadline && !collected.contains("UID=")) delay(50)

            val seen = collected.toString()
            assertTrue(
                "expected the staged host to run the shell at the shell uid; saw:\n$seen",
                seen.contains("UID=2000")
            )
        } finally {
            runCatching { session.close() }
        }
    }
}
