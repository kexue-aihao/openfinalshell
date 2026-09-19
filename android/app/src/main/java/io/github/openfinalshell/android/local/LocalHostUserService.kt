package io.github.openfinalshell.android.local

import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlin.system.exitProcess

/**
 * The Shizuku user service that starts a PTY host at the ADB-shell tier, or at root when Shizuku
 * itself runs as root.
 *
 * Its whole job is copy, verify, execute, report the port. Deliberately no `Context`: a user-service
 * process is not a normal app process, so `registerReceiver` and `getContentResolver` do not work
 * there, and this class never needs them.
 *
 * The copy is not gratuitous. The helper ships inside the app's APK and lands in the native library
 * directory, whose extracted mode is not guaranteed to carry the execute bit — and a privileged
 * process must not depend on that. Copying into a directory this uid owns, then setting 0700, makes
 * the mode irrelevant and keeps the helper somewhere only this uid can reach.
 */
class LocalHostUserService : ILocalHost.Stub() {
    @Volatile private var helperPath: String? = null

    @Volatile private var expectedDigest: String? = null

    // java.lang.Process, which is what ProcessBuilder.start() returns. android.os.Process is spelled
    // out below rather than imported, so the two can never be confused for one another.
    private val children = mutableListOf<Process>()

    override fun configure(helperPath: String, helperSha256: String) {
        this.helperPath = helperPath
        this.expectedDigest = helperSha256.lowercase()
    }

    override fun start(args: Array<String>): Int {
        val source = File(helperPath ?: error("configure() was never called"))
        check(source.isFile) { "the helper is missing at ${source.path}" }

        val directory = File(WORK_ROOT, "ofs-local-${UUID.randomUUID()}")
        check(directory.mkdirs()) { "cannot create ${directory.path}" }
        ownerOnly(directory)

        val helper = File(directory, "ofspty")
        source.inputStream().use { input -> helper.outputStream().use { output -> input.copyTo(output) } }

        val digest = sha256(helper)
        val expected = expectedDigest
        check(expected == null || digest == expected) {
            "the helper changed between the app reading it and this service copying it"
        }
        ownerOnly(helper)

        val process = ProcessBuilder(listOf(helper.absolutePath) + args)
            // The host never writes to stdout again after the port, but a full stderr pipe would
            // deadlock it. A file keeps the diagnostics without the deadlock.
            .redirectError(File(directory, "ofspty.err"))
            .start()
        synchronized(children) {
            // Anything already finished is dropped so a long session cannot grow this without bound.
            children.removeAll { !it.isAlive }
            children += process
        }

        val port = LocalHostProcess.awaitPort(process)
        if (port <= 0) {
            runCatching { process.destroy() }
            return 0
        }
        return port
    }

    override fun describe(): String = "uid=${android.os.Process.myUid()} selinux=${selinuxContext()}"

    override fun stopAll() {
        val running = synchronized(children) {
            val copy = children.toList()
            children.clear()
            copy
        }
        running.forEach { runCatching { it.destroy() } }
    }

    override fun destroy() {
        stopAll()
        // The process is not killed for us when the service is unbound.
        exitProcess(0)
    }

    /** 0700: readable, writable and executable by this uid only. */
    private fun ownerOnly(file: File) {
        file.setReadable(false, false)
        file.setWritable(false, false)
        file.setExecutable(false, false)
        file.setReadable(true, true)
        file.setWritable(true, true)
        file.setExecutable(true, true)
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun selinuxContext(): String =
        runCatching { File("/proc/self/attr/current").readText().trim() }.getOrDefault("unknown")

    private companion object {
        const val WORK_ROOT = "/data/local/tmp"
    }
}
