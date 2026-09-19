package io.github.openfinalshell.android.local

import android.content.Context
import io.github.openfinalshell.android.core.local.HostLauncher
import io.github.openfinalshell.android.core.local.HostRequest
import io.github.openfinalshell.android.core.local.LocalHostArgs
import io.github.openfinalshell.android.core.local.LocalHostStream
import io.github.openfinalshell.android.core.local.SocketLocalHostStream
import io.github.openfinalshell.android.core.sftp.SafeTar
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Reaches the root tier on a device that has `su` but no Shizuku.
 *
 * When Shizuku is installed and running as root (the Sui module) the Shizuku launcher already serves
 * this tier, so this path exists only for the rooted-without-Shizuku case.
 *
 * No JVM, no AIDL and no `app_process` are needed here, because the host owns the PTY itself: `su`
 * only has to run one shell script. That also sidesteps the reason the Shizuku path needs a copy —
 * a binary executed from the native library directory may not carry the execute bit.
 */
class RootHostLauncher(private val context: Context) : HostLauncher {
    /**
     * Existence of `su` only.
     *
     * Deliberately does not *invoke* it: every root manager prompts on first use, and a tier probe
     * must never raise a system dialog just because a screen was opened. The prompt happens at
     * [launch], which is after the user has confirmed the tier inside the app.
     */
    override suspend fun isAvailable(): Boolean = withContext(Dispatchers.IO) { suBinary() != null }

    override suspend fun launch(request: HostRequest): LocalHostStream = withContext(Dispatchers.IO) {
        val su = suBinary() ?: error("no su binary on this device")
        val helper = LocalHostBinary.file(context)
        check(helper.isFile) { "the helper is missing at ${helper.path}" }
        val expected = LocalHostBinary.sha256(context)
        val directory = "/data/local/tmp/ofs-local-${UUID.randomUUID()}"
        val target = "$directory/ofspty"
        val args = LocalHostArgs.build(request).joinToString(" ") { SafeTar.quote(it) }

        val script = buildString {
            append("mkdir -p ${SafeTar.quote(directory)} && chmod 700 ${SafeTar.quote(directory)} && ")
            append("cp ${SafeTar.quote(helper.path)} ${SafeTar.quote(target)} && ")
            append("chmod 700 ${SafeTar.quote(target)} && ")
            // sha256sum is a toybox applet on most builds but not guaranteed, and a copy made by root
            // from the app's own library directory is already about as trustworthy as root gets.
            // So the check is best-effort: it closes the window between the app hashing the file and
            // this copy, and its absence is not treated as a failure.
            append("if command -v sha256sum >/dev/null 2>&1; then ")
            append("[ \"$(sha256sum ${SafeTar.quote(target)} | cut -d' ' -f1)\" = ${SafeTar.quote(expected)} ] || exit 9; ")
            append("fi && ")
            // exec, so the host inherits this pipe as stdout and can report its port on it.
            append("exec ${SafeTar.quote(target)} $args")
        }

        val process = ProcessBuilder(su, "-c", script)
            // A full stderr pipe would deadlock the host; a file keeps the diagnostics.
            .redirectError(File(context.cacheDir, "ofspty-root.err"))
            .start()
        val port = LocalHostProcess.awaitPort(process)
        if (port <= 0) {
            runCatching { process.destroyForcibly() }
            val detail = runCatching { File(context.cacheDir, "ofspty-root.err").readText().trim() }.getOrDefault("")
            error("the root host did not report a port${if (detail.isEmpty()) "" else ": $detail"}")
        }
        SocketLocalHostStream(port)
    }

    override suspend fun shutdown() = Unit

    /** The first `su` that exists, in the order root managers place them. */
    private fun suBinary(): String? = SU_LOCATIONS.firstOrNull { File(it).canExecute() }

    private companion object {
        val SU_LOCATIONS = listOf(
            "/system/bin/su",
            "/system/xbin/su",
            "/sbin/su",
            "/su/bin/su",
            "/debug_ramdisk/su",
            "/system/sbin/su"
        )
    }
}
