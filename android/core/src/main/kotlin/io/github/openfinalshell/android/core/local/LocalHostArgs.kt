package io.github.openfinalshell.android.core.local

/**
 * The argv and the stdout contract for the native host, shared by every launcher.
 *
 * Kept in one place because three call sites build these arguments — the Shizuku user service, the
 * `su` path, and the tests — and a host started with a subtly different argv would fail in a way
 * that looks like a privilege problem rather than an argument problem.
 */
object LocalHostArgs {
    const val PORT_PREFIX = "PORT "
    const val EPHEMERAL_PORT = 0

    /**
     * `--port 0` asks the host to bind an ephemeral port and print it as `PORT <n>`.
     *
     * A caller-chosen port would race: between probing for a free one and the host binding it,
     * another process on the device can take it.
     */
    fun build(request: HostRequest, port: Int = EPHEMERAL_PORT): Array<String> = buildList {
        add("--port"); add(port.toString())
        add("--token"); add(request.token)
        add("--shell"); add(request.shellPath)
        add("--cwd"); add(request.workingDirectory)
        add("--cols"); add(request.cols.toString())
        add("--rows"); add(request.rows.toString())
        if (request.command != null) {
            add("--mode"); add("exec")
            add("--command"); add(request.command)
        }
        request.environment.forEach { entry ->
            add("--env"); add(entry)
        }
    }.toTypedArray()

    /** Reads the port out of the host's first stdout line, or null when the line is not one. */
    fun parsePort(line: String): Int? =
        line.trim().removePrefix(PORT_PREFIX).trim().toIntOrNull()?.takeIf { it in 1..65535 }
}
