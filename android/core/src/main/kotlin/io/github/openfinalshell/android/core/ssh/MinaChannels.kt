package io.github.openfinalshell.android.core.ssh

import java.io.InputStream
import java.nio.ByteBuffer
import java.util.EnumSet
import java.util.concurrent.Executors
import java.util.concurrent.ExecutorService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import org.apache.sshd.client.channel.ChannelShell
import org.apache.sshd.client.channel.ClientChannel
import org.apache.sshd.sftp.client.SftpClient

internal class MinaShellChannel(private val channel: ChannelShell) : ShellChannel {
    private val readerExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val clientChannel: ClientChannel = channel
    private val mutableEvents = MutableSharedFlow<ShellEvent>(replay = 1, extraBufferCapacity = 1)
    override val events: SharedFlow<ShellEvent> = mutableEvents.asSharedFlow()
    @Volatile private var closed = false

    override val output: Flow<ByteArray> = callbackFlow {
        val input: InputStream = clientChannel.getInvertedOut()
        val reader = readerExecutor.submit {
            val buffer = ByteArray(8192)
            try {
                while (!Thread.currentThread().isInterrupted) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (count > 0) trySend(buffer.copyOf(count))
                }
                markClosed(ShellCloseReason.CLOSED)
            } catch (_: InterruptedException) {
                // Closing the channel interrupts the reader as part of normal lifecycle cleanup.
            } catch (_: Throwable) {
                markClosed(ShellCloseReason.ERROR)
            } finally {
                kotlinx.coroutines.runBlocking { close() }
            }
        }
        awaitClose { reader.cancel(true) }
    }

    override suspend fun write(data: ByteArray) = withContext(Dispatchers.IO) {
        clientChannel.getInvertedIn().write(data)
        clientChannel.getInvertedIn().flush()
    }

    override suspend fun resize(cols: Int, rows: Int) {
        require(cols > 0 && rows > 0)
        channel.setPtyColumns(cols)
        channel.setPtyLines(rows)
    }

    override suspend fun close() {
        withContext(Dispatchers.IO) {
            markClosed(ShellCloseReason.CLOSED)
            channel.close(false)
            readerExecutor.shutdownNow()
        }
    }

    private fun markClosed(reason: ShellCloseReason) {
        if (closed) return
        closed = true
        mutableEvents.tryEmit(ShellEvent.Closed(reason))
    }
}

/** One-shot exec channel used by monitor and port-traffic collectors. */
internal class MinaExecChannel(private val channel: ClientChannel) : ExecChannel {
    private val readerExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val mutableExitCode = MutableStateFlow<Int?>(null)
    override val exitCode: kotlinx.coroutines.flow.StateFlow<Int?> = mutableExitCode
    @Volatile private var closed = false

    override val output: Flow<ByteArray> = callbackFlow {
        val input = this@MinaExecChannel.channel.getInvertedOut()
        val reader = readerExecutor.submit {
            val buffer = ByteArray(8192)
            try {
                while (!Thread.currentThread().isInterrupted) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (count > 0) trySend(buffer.copyOf(count))
                }
            } catch (_: InterruptedException) {
                // Normal shutdown interrupts the blocking read.
            } catch (_: Throwable) {
                // The command output is best-effort; the caller observes a missing/failed frame.
            } finally {
                closeQuietly()
                close()
            }
        }
        awaitClose { reader.cancel(true) }
    }

    override suspend fun close() = withContext(Dispatchers.IO) { closeQuietly() }

    private fun closeQuietly() {
        if (closed) return
        closed = true
        runCatching { channel.close(false) }
        readerExecutor.shutdownNow()
    }
}

internal class MinaSftpChannel(private val client: SftpClient) : SftpChannel {
    override suspend fun list(path: String): List<SftpEntry> = withContext(Dispatchers.IO) {
        client.readDir(path).map { entry ->
            val attrs = entry.attributes
            val type = when {
                attrs.isDirectory -> SftpEntry.Type.DIRECTORY
                attrs.isRegularFile -> SftpEntry.Type.FILE
                attrs.isSymbolicLink -> SftpEntry.Type.SYMLINK
                else -> SftpEntry.Type.OTHER
            }
            SftpEntry(entry.filename, path.trimEnd('/') + "/" + entry.filename, type, attrs.size)
        }.toList()
    }

    override suspend fun read(path: String): ByteArray = withContext(Dispatchers.IO) {
        client.read(path).use { it.readBytes() }
    }

    override suspend fun readChunk(path: String, offset: Long, maxBytes: Int): ByteArray = withContext(Dispatchers.IO) {
        require(offset >= 0 && maxBytes > 0)
        client.openRemoteFileChannel(path, EnumSet.of(SftpClient.OpenMode.Read)).use { channel ->
            channel.position(offset)
            val buffer = ByteBuffer.allocate(maxBytes)
            while (buffer.hasRemaining() && channel.read(buffer) > 0) { }
            buffer.flip()
            ByteArray(buffer.remaining()).also { buffer.get(it) }
        }
    }

    override suspend fun write(path: String, data: ByteArray) = withContext(Dispatchers.IO) {
        client.write(path).use { it.write(data) }
    }

    override suspend fun mkdir(path: String) = withContext(Dispatchers.IO) { client.mkdir(path) }

    override suspend fun rename(from: String, to: String) = withContext(Dispatchers.IO) { client.rename(from, to) }

    override suspend fun writeChunk(path: String, data: ByteArray, offset: Long, truncate: Boolean) = withContext(Dispatchers.IO) {
        val modes = EnumSet.of(
            SftpClient.OpenMode.Write,
            SftpClient.OpenMode.Create
        )
        if (truncate) modes += SftpClient.OpenMode.Truncate
        client.openRemoteFileChannel(path, modes).use { channel ->
            channel.position(offset)
            val buffer = ByteBuffer.wrap(data)
            while (buffer.hasRemaining()) channel.write(buffer)
        }
    }

    override suspend fun delete(path: String, recursive: Boolean) = withContext(Dispatchers.IO) {
        if (!recursive) {
            client.remove(path)
        } else {
            removeRecursively(path)
        }
    }

    override suspend fun close() = withContext(Dispatchers.IO) { client.close() }

    private fun removeRecursively(path: String) {
        val attrs = client.stat(path)
        if (!attrs.isDirectory) {
            client.remove(path)
            return
        }
        client.readDir(path).forEach { entry ->
            if (entry.filename != "." && entry.filename != "..") {
                removeRecursively(path.trimEnd('/') + "/" + entry.filename)
            }
        }
        client.rmdir(path)
    }
}
