package io.github.openfinalshell.android.core.ssh

import java.io.InputStream
import java.nio.ByteBuffer
import java.util.EnumSet
import java.util.concurrent.Executors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import org.apache.sshd.client.channel.ChannelShell
import org.apache.sshd.sftp.client.SftpClient

internal class MinaShellChannel(private val channel: ChannelShell) : ShellChannel {
    private val readerExecutor = Executors.newSingleThreadExecutor()

    override val output: Flow<ByteArray> = callbackFlow {
        val input: InputStream = channel.getInvertedOut()
        val reader = readerExecutor.submit {
            val buffer = ByteArray(8192)
            try {
                while (!Thread.currentThread().isInterrupted) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (count > 0) trySend(buffer.copyOf(count))
                }
            } finally {
                close()
            }
        }
        awaitClose { reader.cancel(true) }
    }

    override suspend fun write(data: ByteArray) = withContext(Dispatchers.IO) {
        channel.getInvertedIn().write(data)
        channel.getInvertedIn().flush()
    }

    override suspend fun resize(cols: Int, rows: Int) {
        require(cols > 0 && rows > 0)
        channel.setPtyColumns(cols)
        channel.setPtyLines(rows)
    }

    override suspend fun close() {
        withContext(Dispatchers.IO) { channel.close(false) }
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

    override suspend fun write(path: String, data: ByteArray) = withContext(Dispatchers.IO) {
        client.write(path).use { it.write(data) }
    }

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
        // Recursive traversal is deliberately owned by the queue layer so that each child
        // operation can report progress and cancellation like the desktop implementation.
        client.remove(path)
    }

    override suspend fun close() = withContext(Dispatchers.IO) { client.close() }
}
