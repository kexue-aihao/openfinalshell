package io.github.openfinalshell.android.local

import io.github.openfinalshell.android.core.ssh.ExecChannel
import io.github.openfinalshell.android.core.ssh.ShellChannel
import io.github.openfinalshell.android.core.ssh.ShellCloseReason
import io.github.openfinalshell.android.core.ssh.ShellEvent
import io.github.openfinalshell.android.terminal.LocalTerminalController
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn

/**
 * The interactive shell of a local session.
 *
 * `ownsEmulator` is true because the Termux session behind [controller] already appends every byte
 * to its own emulator. [output] is therefore empty rather than a second copy of the same bytes, and
 * the caller must not start a collect-into-controller job for this channel.
 */
class LocalShellChannel(val controller: LocalTerminalController) : ShellChannel {
    override val ownsEmulator = true

    override val output: Flow<ByteArray> = emptyFlow()

    /** The shell exiting is the end of this channel; there is no socket to lose. */
    override val events: Flow<ShellEvent> = flow {
        controller.finished.await()
        emit(ShellEvent.Closed(ShellCloseReason.CLOSED))
    }

    override suspend fun write(data: ByteArray) = controller.sendInput(data)

    override suspend fun resize(cols: Int, rows: Int) = controller.resize(cols, rows)

    override suspend fun close() = controller.closeSession()
}

/**
 * A one-shot local command, backing the same sentinel frames the monitor and the file panel use.
 *
 * stderr is merged into stdout exactly as the SSH transport does, because the monitor parses
 * sections out of a single ordered stream: a diagnostic landing on a separate stream would either
 * be lost or reorder the sentinels around it.
 */
class LocalExecChannel(private val process: Process) : ExecChannel {
    private val mutableExitCode = MutableStateFlow<Int?>(null)
    override val exitCode: StateFlow<Int?> = mutableExitCode.asStateFlow()

    override val output: Flow<ByteArray> = flow {
        val stream = process.inputStream
        try {
            val buffer = ByteArray(READ_BUFFER)
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                if (read > 0) emit(buffer.copyOf(read))
            }
        } finally {
            // Recorded here, not in close(): a caller reads exitCode right after the stream ends,
            // and the monitor treats end-of-stream as the end of the command.
            mutableExitCode.value = runCatching { process.waitFor() }.getOrDefault(-1)
            runCatching { stream.close() }
        }
    }.flowOn(Dispatchers.IO)

    override suspend fun close() {
        if (mutableExitCode.value != null) return
        runCatching { process.destroy() }
        val exited = runCatching { process.waitFor(CLOSE_GRACE_MS, TimeUnit.MILLISECONDS) }.getOrDefault(false)
        // A shell command that ignores the polite signal must not outlive its channel.
        if (!exited) runCatching { process.destroyForcibly() }
    }

    companion object {
        fun start(shellPath: String, command: String, workingDirectory: String, environment: Array<String>): LocalExecChannel {
            val process = ProcessBuilder(listOf(shellPath, "-c", command))
                .directory(java.io.File(workingDirectory))
                .redirectErrorStream(true)
                .also { it.environment().putAll(environment.associate { entry -> entry.substringBefore('=') to entry.substringAfter('=') }) }
                .start()
            return LocalExecChannel(process)
        }

        private const val READ_BUFFER = 8 * 1024
        private const val CLOSE_GRACE_MS = 250L
    }
}
