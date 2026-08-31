package io.github.openfinalshell.android.core.sftp

import io.github.openfinalshell.android.core.ssh.SftpChannel
import io.github.openfinalshell.android.core.ssh.SftpEntry
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TransferQueueTest {
    @Test
    fun uploadClosesItsChannelAndReportsCompletion() = runTest {
        val channel = RecordingChannel()
        val queue = TransferQueue(this)

        queue.enqueueUpload("/tmp/out", "hello".toByteArray(), channel)
        advanceUntilIdle()

        assertEquals(TransferState.COMPLETED, queue.tasks.value.single().state)
        assertArrayEquals("hello".toByteArray(), channel.written.toByteArray())
        assertEquals(1, channel.closeCount)
    }

    @Test
    fun downloadReadsChunksAndClosesItsChannel() = runTest {
        val channel = RecordingChannel("download-data".toByteArray())
        val sink = RecordingSink()
        val queue = TransferQueue(this)

        queue.enqueueDownload("/tmp/in", sink, channel, bytesTotal = 13)
        advanceUntilIdle()

        assertEquals(TransferState.COMPLETED, queue.tasks.value.single().state)
        assertArrayEquals("download-data".toByteArray(), sink.bytes.toByteArray())
        assertEquals(1, channel.closeCount)
    }

    @Test
    fun retryRequestsANewChannel() = runTest {
        val failed = RecordingChannel(failWrites = true)
        val recovered = RecordingChannel()
        var opens = 0
        val queue = TransferQueue(this)

        val id = queue.enqueueUpload("/tmp/out", "hello".toByteArray(), channelProvider = {
            opens++
            if (opens == 1) failed else recovered
        })
        advanceUntilIdle()
        assertEquals(TransferState.FAILED, queue.tasks.value.single().state)

        queue.retry(id)
        advanceUntilIdle()

        assertEquals(TransferState.COMPLETED, queue.tasks.value.single().state)
        assertEquals(2, opens)
        assertArrayEquals("hello".toByteArray(), recovered.written.toByteArray())
        assertEquals(1, failed.closeCount)
        assertEquals(1, recovered.closeCount)
    }

    private class RecordingChannel(
        private val source: ByteArray = ByteArray(0),
        private val failWrites: Boolean = false
    ) : SftpChannel {
        val written = ArrayList<Byte>()
        var closeCount = 0

        override suspend fun list(path: String): List<SftpEntry> = emptyList()
        override suspend fun read(path: String): ByteArray = source
        override suspend fun readChunk(path: String, offset: Long, maxBytes: Int): ByteArray =
            source.copyOfRange(offset.toInt(), minOf(offset + maxBytes, source.size.toLong()).toInt())
        override suspend fun write(path: String, data: ByteArray) {
            if (failWrites) error("write failed")
            data.forEach(written::add)
        }
        override suspend fun writeChunk(path: String, data: ByteArray, offset: Long, truncate: Boolean) {
            if (failWrites) error("write failed")
            if (truncate) written.clear()
            data.forEach(written::add)
        }
        override suspend fun delete(path: String, recursive: Boolean) = Unit
        override suspend fun close() { closeCount++ }
    }

    private class RecordingSink : TransferSink {
        val bytes = ArrayList<Byte>()
        override suspend fun write(offset: Long, data: ByteArray) { data.forEach(bytes::add) }
    }
}
