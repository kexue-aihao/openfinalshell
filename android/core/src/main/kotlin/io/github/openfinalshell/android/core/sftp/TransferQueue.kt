package io.github.openfinalshell.android.core.sftp

import io.github.openfinalshell.android.core.ssh.SftpChannel
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Transfer direction exposed to Android callers. */
enum class TransferKind { UPLOAD, DOWNLOAD }

enum class TransferState { QUEUED, RUNNING, PAUSED, COMPLETED, FAILED, CANCELED }

/** A source that can be read again when a task is retried. */
interface TransferSource {
    val size: Long
    val supportsResume: Boolean get() = true
    suspend fun read(offset: Long, maxBytes: Int): ByteArray
    suspend fun close() = Unit
    suspend fun complete() = Unit
    suspend fun abort() = close()
}

/** Byte-array compatibility adapter for the original enqueueUpload API. */
private class ByteArraySource(private val bytes: ByteArray) : TransferSource {
    override val size: Long = bytes.size.toLong()

    override suspend fun read(offset: Long, maxBytes: Int): ByteArray {
        if (offset >= bytes.size) return ByteArray(0)
        val start = offset.toInt()
        val end = minOf(start + maxBytes, bytes.size)
        return bytes.copyOfRange(start, end)
    }
}

/** Destination for a download. Implementations can reset/truncate before retrying. */
interface TransferSink {
    val supportsResume: Boolean get() = true
    suspend fun reset() = Unit
    suspend fun write(offset: Long, data: ByteArray)
    suspend fun complete(totalBytes: Long) = Unit
    suspend fun abort() = Unit
    suspend fun pause() = Unit
}

data class TransferTask(
    val id: String,
    val remotePath: String,
    val bytesTotal: Long,
    val bytesTransferred: Long = 0,
    val state: TransferState = TransferState.QUEUED,
    val error: String? = null,
    val kind: TransferKind = TransferKind.UPLOAD,
    val localPath: String? = null,
    val speedBps: Long = 0,
    val createdAt: Long = System.currentTimeMillis(),
    val attempts: Int = 0
)

private class TaskControl {
    @Volatile var paused: Boolean = false
    @Volatile var canceled: Boolean = false
    val channel = java.util.concurrent.atomic.AtomicReference<SftpChannel?>()

    suspend fun closeChannel() = kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
        channel.getAndSet(null)?.let { runCatching { it.close() } }
    }
}

private data class Operation(
    val control: TaskControl,
    val run: suspend (TaskControl, String) -> Unit,
    val retryable: Boolean = true,
    val supportsResume: Boolean = true,
    val discard: suspend () -> Unit = {}
)

/**
 * Bounded, retryable transfer queue. The original byte-array upload method remains source
 * compatible. New callers can use a TransferSource or enqueue a download into a TransferSink.
 */
class TransferQueue(private val scope: CoroutineScope, maxConcurrent: Int = 3) {
    @Volatile private var maxConcurrent = maxConcurrent.coerceIn(1, 8)
    private var running = 0
    private val mutableTasks = MutableStateFlow<List<TransferTask>>(emptyList())
    val tasks: StateFlow<List<TransferTask>> = mutableTasks
    private val lock = Any()
    private val jobs = mutableMapOf<String, Job>()
    private val cleanupJobs = mutableMapOf<String, Job>()
    private val pendingRetries = mutableSetOf<String>()
    private val operations = mutableMapOf<String, Operation>()

    fun enqueueUpload(remotePath: String, data: ByteArray, channel: SftpChannel): String =
        enqueueUpload(remotePath, ByteArraySource(data), channel)

    fun enqueueUpload(
        remotePath: String,
        data: ByteArray,
        channelProvider: suspend () -> SftpChannel,
        localPath: String? = null
    ): String = enqueueUpload(remotePath, ByteArraySource(data), channelProvider, localPath)

    /**
     * Enqueues an upload with a factory that returns a fresh channel for every attempt.
     * The queue owns and closes each channel returned by the factory.
     */
    fun enqueueUpload(
        remotePath: String,
        source: TransferSource,
        channelProvider: suspend () -> SftpChannel,
        localPath: String? = null
    ): String = enqueueUploadInternal(remotePath, source, channelProvider, localPath, retryable = true)

    fun enqueueUpload(
        remotePath: String,
        source: TransferSource,
        channel: SftpChannel,
        localPath: String? = null
    ): String = enqueueUploadInternal(remotePath, source, { channel }, localPath, retryable = false)

    private fun enqueueUploadInternal(
        remotePath: String,
        source: TransferSource,
        channelProvider: suspend () -> SftpChannel,
        localPath: String?,
        retryable: Boolean
    ): String {
        val id = createTask(
            TransferTask(
                id = UUID.randomUUID().toString(),
                remotePath = remotePath,
                bytesTotal = source.size,
                kind = TransferKind.UPLOAD,
                localPath = localPath
            )
        )
        val operation = Operation(TaskControl(), { control, taskId ->
            val channel = channelProvider()
            control.channel.set(channel)
            try {
                checkControl(taskId, control)
                runUpload(taskId, remotePath, source, channel, control)
            } finally {
                control.closeChannel()
            }
        }, retryable = retryable, supportsResume = source.supportsResume, discard = { source.abort() })
        synchronized(lock) { operations[id] = operation }
        launch(id, operation)
        return id
    }

    /**
     * Enqueues a download using the existing SftpChannel contract. A transport that only exposes
     * read() is necessarily buffered by that transport; the sink still receives bounded chunks.
     */
    fun enqueueDownload(
        remotePath: String,
        sink: TransferSink,
        channel: SftpChannel,
        bytesTotal: Long = -1,
        localPath: String? = null
    ): String = enqueueDownloadInternal(remotePath, sink, { channel }, bytesTotal, localPath, retryable = false)

    /** Enqueues a download with a fresh SFTP channel for every attempt. */
    fun enqueueDownload(
        remotePath: String,
        sink: TransferSink,
        channelProvider: suspend () -> SftpChannel,
        bytesTotal: Long = -1,
        localPath: String? = null
    ): String = enqueueDownloadInternal(remotePath, sink, channelProvider, bytesTotal, localPath, retryable = true)

    private fun enqueueDownloadInternal(
        remotePath: String,
        sink: TransferSink,
        channelProvider: suspend () -> SftpChannel,
        bytesTotal: Long,
        localPath: String?,
        retryable: Boolean
    ): String {
        val id = createTask(
            TransferTask(
                id = UUID.randomUUID().toString(),
                remotePath = remotePath,
                bytesTotal = bytesTotal,
                kind = TransferKind.DOWNLOAD,
                localPath = localPath
            )
        )
        val operation = Operation(TaskControl(), { control, taskId ->
            val channel = channelProvider()
            control.channel.set(channel)
            try {
                checkControl(taskId, control)
                runDownload(taskId, remotePath, sink, channel, control)
            } finally {
                control.closeChannel()
            }
        }, retryable = retryable, supportsResume = sink.supportsResume, discard = { sink.abort() })
        synchronized(lock) { operations[id] = operation }
        launch(id, operation)
        return id
    }

    fun pause(id: String) {
        synchronized(lock) {
            operations[id]?.control?.paused = true
            val task = task(id) ?: return
            if (task.state == TransferState.QUEUED || task.state == TransferState.RUNNING) {
                setTask(task.copy(state = TransferState.PAUSED))
            }
        }
    }

    fun resume(id: String) {
        val operation: Operation?
        synchronized(lock) {
            if (task(id)?.state != TransferState.PAUSED) return
            operation = operations[id]
            if (operation?.retryable == false) return
            operation?.control?.paused = false
            val task = task(id) ?: return
            if (task.state == TransferState.PAUSED) setTask(task.copy(state = TransferState.QUEUED, error = null,
                bytesTransferred = if (operation?.supportsResume == false) 0 else task.bytesTransferred))
        }
        if (operation != null && synchronized(lock) { jobs[id]?.isActive != true }) launch(id, operation!!)
    }

    fun retry(id: String) {
        val operation: Operation?
        synchronized(lock) {
            val cleanup = cleanupJobs[id]
            if (cleanup?.isActive == true) {
                if (pendingRetries.add(id)) scope.launch {
                    cleanup.join()
                    synchronized(lock) { pendingRetries.remove(id) }
                    retry(id)
                }
                return
            }
            val task = task(id) ?: return
            if (task.state != TransferState.FAILED && task.state != TransferState.CANCELED) return
            operation = operations[id]
            if (operation?.retryable == false) return
            operation?.control?.apply {
                paused = false
                canceled = false
            }
            if (operation != null) {
                setTask(task.copy(state = TransferState.QUEUED, bytesTransferred = 0, error = null, attempts = task.attempts + 1))
            }
        }
        if (operation != null) launch(id, operation!!)
    }

    fun cancel(id: String) {
        synchronized(lock) {
            if (task(id)?.state == TransferState.COMPLETED || cleanupJobs[id]?.isActive == true) return
            val operation = operations[id] ?: return
            operation.control.canceled = true
            operation.control.paused = false
            task(id)?.let { task ->
                if (task.state != TransferState.COMPLETED && task.state != TransferState.FAILED) {
                    setTask(task.copy(state = TransferState.CANCELED))
                }
            }
            val job = jobs.remove(id)
            job?.cancel()
            val cleanup = scope.launch(kotlinx.coroutines.NonCancellable, start = kotlinx.coroutines.CoroutineStart.LAZY) {
                try {
                    // Closing the owned channel interrupts a blocked network read before joining.
                    operation.control.closeChannel()
                    job?.join()
                    runCatching { operation.discard() }
                } finally {
                    synchronized(lock) { cleanupJobs.remove(id) }
                }
            }
            cleanupJobs[id] = cleanup
            cleanup.start()
        }
    }

    fun cancelAll() {
        val ids = synchronized(lock) { operations.keys.toList() }
        ids.forEach(::cancel)
    }

    fun setConcurrency(value: Int) { maxConcurrent = value.coerceIn(1, 8) }

    fun clearFinished() {
        synchronized(lock) {
            val remaining = mutableTasks.value.filterNot {
                it.state == TransferState.COMPLETED || it.state == TransferState.FAILED || it.state == TransferState.CANCELED
            }
            mutableTasks.value = remaining
            operations.keys.retainAll(remaining.mapTo(mutableSetOf()) { it.id })
        }
    }

    private fun createTask(initial: TransferTask): String {
        synchronized(lock) { mutableTasks.value = mutableTasks.value + initial }
        return initial.id
    }

    private fun launch(id: String, operation: Operation) {
        synchronized(lock) {
            if (jobs[id]?.isActive == true) return
            jobs[id] = scope.launch {
                try {
                    waitUntilRunnable(id, operation.control)
                    while (!synchronized(lock) { if (running < maxConcurrent) { running++; true } else false }) {
                        checkControl(id, operation.control)
                        delay(50)
                    }
                    try { operation.run(operation.control, id) }
                    finally { synchronized(lock) { running-- } }
                    synchronized(lock) {
                        task(id)?.takeUnless { it.state == TransferState.CANCELED }?.let {
                            setTask(it.copy(state = TransferState.COMPLETED, bytesTransferred = it.bytesTotal.coerceAtLeast(it.bytesTransferred)))
                        }
                    }
                } catch (_: PauseRequested) {
                    synchronized(lock) {
                        task(id)?.let { setTask(it.copy(state = if (operation.control.paused) TransferState.PAUSED else TransferState.QUEUED)) }
                    }
                } catch (_: CancellationException) {
                    kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { runCatching { operation.discard() } }
                    synchronized(lock) { task(id)?.let { setTask(it.copy(state = TransferState.CANCELED)) } }
                } catch (error: Throwable) {
                    kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { runCatching { operation.discard() } }
                    synchronized(lock) { task(id)?.let {
                        setTask(if (operation.control.canceled) it.copy(state = TransferState.CANCELED, error = null)
                            else it.copy(state = TransferState.FAILED, error = error.message ?: error.javaClass.simpleName))
                    } }
                } finally {
                    val currentJob = coroutineContext[Job]
                    val restart = synchronized(lock) {
                        if (jobs[id] !== currentJob) false else {
                            jobs.remove(id)
                            task(id)?.state == TransferState.QUEUED && !operation.control.paused && !operation.control.canceled
                        }
                    }
                    if (restart) launch(id, operation)
                }
            }
        }
    }

    private suspend fun waitUntilRunnable(id: String, control: TaskControl) {
        while (control.paused && !control.canceled) {
            synchronized(lock) { task(id)?.let { if (it.state != TransferState.PAUSED) setTask(it.copy(state = TransferState.PAUSED)) } }
            delay(100)
        }
        if (control.canceled) throw CancellationException("transfer canceled")
    }

    private suspend fun runUpload(
        id: String,
        remotePath: String,
        source: TransferSource,
        channel: SftpChannel,
        control: TaskControl
    ) {
        try {
            updateRunning(id)
            var offset = synchronized(lock) { task(id)?.bytesTransferred?.coerceIn(0L, source.size) ?: 0L }
            val startedAt = System.nanoTime()
            if (source.size == 0L) {
                checkControl(id, control)
                channel.writeChunk(remotePath, ByteArray(0), 0, truncate = true)
            }
            while (offset < source.size) {
                checkControl(id, control)
                val chunk = source.read(offset, CHUNK_SIZE)
                if (chunk.isEmpty()) error("upload source ended before ${source.size} bytes")
                channel.writeChunk(remotePath, chunk, offset, truncate = offset == 0L)
                offset += chunk.size
                reportProgress(id, offset, startedAt)
            }
            checkControl(id, control)
            source.complete()
        } catch (paused: PauseRequested) {
            throw paused
        } catch (error: Throwable) {
            source.abort()
            throw error
        } finally {
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { source.close() }
        }
    }

    private suspend fun runDownload(
        id: String,
        remotePath: String,
        sink: TransferSink,
        channel: SftpChannel,
        control: TaskControl
    ) {
        var offset = synchronized(lock) { task(id)?.bytesTransferred?.coerceAtLeast(0L) ?: 0L }
        val startedAt = System.nanoTime()
        try {
            // A paused transfer keeps its partial destination. Retries explicitly reset the
            // task's byte count, so they still start from a clean destination.
            if (offset == 0L) sink.reset()
            updateRunning(id)
            val expectedTotal = synchronized(lock) { task(id)?.bytesTotal ?: -1L }
            while (expectedTotal < 0 || offset < expectedTotal) {
                checkControl(id, control)
                val chunk = channel.readChunk(remotePath, offset, CHUNK_SIZE)
                if (chunk.isEmpty()) break
                sink.write(offset, chunk)
                offset += chunk.size
                reportProgress(id, offset, startedAt)
            }
            if (expectedTotal >= 0 && offset != expectedTotal) {
                error("download ended at $offset of $expectedTotal bytes")
            }
            synchronized(lock) { task(id)?.let { if (it.bytesTotal < 0) setTask(it.copy(bytesTotal = offset)) } }
            checkControl(id, control)
            sink.complete(offset)
        } catch (paused: PauseRequested) {
            sink.pause()
            throw paused
        } catch (error: Throwable) {
            sink.abort()
            throw error
        }
    }

    private fun checkControl(id: String, control: TaskControl) {
        if (control.canceled) throw CancellationException("transfer canceled")
        if (control.paused) {
            synchronized(lock) { task(id)?.let { setTask(it.copy(state = TransferState.PAUSED)) } }
            throw PauseRequested()
        }
    }

    private fun updateRunning(id: String) {
        synchronized(lock) {
            task(id)?.let { if (it.state != TransferState.CANCELED) setTask(it.copy(state = TransferState.RUNNING)) }
        }
    }

    private fun reportProgress(id: String, transferred: Long, startedAt: Long) {
        val elapsedSeconds = ((System.nanoTime() - startedAt).coerceAtLeast(1L)).toDouble() / 1_000_000_000.0
        val speed = (transferred / elapsedSeconds).toLong()
        synchronized(lock) { task(id)?.let { setTask(it.copy(bytesTransferred = transferred, speedBps = speed, state = TransferState.RUNNING)) } }
    }

    private fun task(id: String): TransferTask? = mutableTasks.value.firstOrNull { it.id == id }

    private fun setTask(task: TransferTask) {
        mutableTasks.value = mutableTasks.value.map { if (it.id == task.id) task else it }
    }

    private class PauseRequested : CancellationException("transfer paused")

    private companion object {
        const val CHUNK_SIZE = 32 * 1024
    }
}
