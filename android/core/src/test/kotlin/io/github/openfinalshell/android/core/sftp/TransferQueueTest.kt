package io.github.openfinalshell.android.core.sftp

import io.github.openfinalshell.android.core.ssh.SftpChannel
import io.github.openfinalshell.android.core.ssh.SftpEntry
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertTrue
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TransferQueueTest {
    @Test fun cancellationInterruptsOwnedChannelBeforeWaitingForRead() = runTest {
        val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
        val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
        var closeCount=0
        val channel=object:SftpChannel {
            override suspend fun list(path:String)=emptyList<SftpEntry>()
            override suspend fun read(path:String)=ByteArray(0)
            override suspend fun write(path:String,data:ByteArray)=Unit
            override suspend fun delete(path:String,recursive:Boolean)=Unit
            override suspend fun readChunk(path:String,offset:Long,maxBytes:Int):ByteArray = kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
                entered.complete(Unit);closed.await();throw java.io.IOException("closed")
            }
            override suspend fun close() { kotlinx.coroutines.delay(1);closeCount++;closed.complete(Unit) }
        }
        val queue=TransferQueue(this)
        val id=queue.enqueueDownload("/blocked",RecordingSink(),channel,1)
        runCurrent()
        assertTrue(entered.isCompleted)
        queue.cancel(id)
        advanceUntilIdle()
        assertTrue(closed.isCompleted)
        assertEquals(1,closeCount)
        assertEquals(TransferState.CANCELED,queue.tasks.value.single().state)
    }
    @Test
    fun cancelThenImmediateRetryWaitsForOldCleanup() = runTest {
        val queue = TransferQueue(this)
        val started = kotlinx.coroutines.CompletableDeferred<Unit>()
        var attempts = 0
        var cleanupFinished = false
        val source = object : TransferSource {
            override val size = 1L
            override suspend fun read(offset: Long, maxBytes: Int): ByteArray {
                attempts++
                if (attempts == 1) { started.complete(Unit); kotlinx.coroutines.awaitCancellation() }
                assertEquals(true, cleanupFinished)
                return byteArrayOf(42)
            }
            override suspend fun abort() { kotlinx.coroutines.delay(10); cleanupFinished = true }
        }
        val id = queue.enqueueUpload("/retry", source, channelProvider = { RecordingChannel() })
        started.await()
        queue.cancel(id)
        queue.retry(id)
        advanceUntilIdle()
        assertEquals(TransferState.COMPLETED, queue.tasks.value.single().state)
        assertEquals(2, attempts)
    }

    @Test
    fun emptyUploadCreatesAndTruncatesRemoteFile() = runTest {
        val channel = RecordingChannel()
        channel.written.add(42)
        val queue = TransferQueue(this)
        queue.enqueueUpload("/empty", ByteArray(0), channel)
        advanceUntilIdle()
        assertEquals(TransferState.COMPLETED, queue.tasks.value.single().state)
        assertEquals(0, channel.written.size)
    }

    @Test
    fun unseekableSourceRestartsFromZeroAfterPause() = runTest {
        val queue = TransferQueue(this)
        var id = ""
        var firstAttempt = true
        val offsets = mutableListOf<Long>()
        val source = object : TransferSource {
            override val size = 64L * 1024
            override val supportsResume = false
            override suspend fun read(offset: Long, maxBytes: Int): ByteArray {
                offsets += offset
                if (firstAttempt) { firstAttempt = false; queue.pause(id) }
                return ByteArray(minOf(maxBytes.toLong(), size - offset).toInt())
            }
        }
        id = queue.enqueueUpload("/pipe", source, channelProvider = { RecordingChannel() })
        advanceUntilIdle()
        assertEquals(TransferState.PAUSED, queue.tasks.value.single().state)
        queue.resume(id)
        advanceUntilIdle()
        assertEquals(listOf(0L, 0L, 32768L), offsets)
        assertEquals(TransferState.COMPLETED, queue.tasks.value.single().state)
    }

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
