package io.github.openfinalshell.android.local

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LocalShellSpecTest {
    // The paths are Unix-shaped because that is what the device has, but the expectation is built
    // from the File objects rather than written out: this test also runs on the Windows JVM the
    // unit tests are launched from, where File.path separates with a backslash.
    private val home = File("/data/data/app/files/home")
    private val temp = File("/data/data/app/cache/tmp")

    private fun spec(startDirectory: String? = null) = LocalShellSpec(
        shellPath = LocalShellSpec.DEFAULT_SHELL,
        homeDirectory = home,
        tempDirectory = temp,
        startDirectory = startDirectory,
        transcriptRows = 500,
        termType = "xterm-256color"
    )

    @Test
    fun `environment names the host so the shell prompt is not blank`() {
        // The PTY host overlays these entries onto the environment it inherited rather than
        // replacing it, and the app tier has no HOSTNAME to inherit. The shell's built-in prompt is
        // `$HOSTNAME:${PWD:-?} $`, so without this entry the app tier's prompt started at the colon
        // while the privileged tiers, which inherit one, did not.
        assertTrue(
            "HOSTNAME must travel or the app tier's prompt loses its host",
            spec().environment.contains("HOSTNAME=${LocalShellSpec.LOCAL_HOSTNAME}")
        )
    }

    @Test
    fun `environment carries the directories and terminal type the session depends on`() {
        val environment = spec().environment
        assertEquals("HOME=${home.path}", environment.first { it.startsWith("HOME=") })
        assertEquals("TMPDIR=${temp.path}", environment.first { it.startsWith("TMPDIR=") })
        assertEquals("SHELL=${LocalShellSpec.DEFAULT_SHELL}", environment.first { it.startsWith("SHELL=") })
        assertEquals("TERM=xterm-256color", environment.first { it.startsWith("TERM=") })
    }

    @Test
    fun `no environment entry is set twice`() {
        // The PTY host applies these with setenv in order, so a repeated name silently means the
        // later entry wins and the earlier one is dead weight the reader cannot see.
        val names = spec().environment.map { it.substringBefore('=') }
        assertEquals(names.size, names.toSet().size)
    }

    @Test
    fun `working directory falls back to home when the profile gives no start directory`() {
        assertEquals(home.path, spec().workingDirectory)
        assertEquals("/sdcard/Download", spec(startDirectory = "/sdcard/Download").workingDirectory)
        // A blank entry is a profile that was saved without one, not a request to start at the root.
        assertEquals(home.path, spec(startDirectory = "   ").workingDirectory)
    }
}
