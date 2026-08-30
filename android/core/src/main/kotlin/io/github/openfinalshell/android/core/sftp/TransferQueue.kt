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
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

enum class TransferState { QUEUED, RUNNING, PAUSED, COMPLETED, FAILED, CANCELED }

data class TransferTask(
    val id: String,
    val remotePath: String,
    val bytesTotal: Long,
    val bytesTransferred: Long = 0,
    val state: TransferState = TransferState.QUEUED,
    val error: String? = null
)

/** Coroutine transfer queue with bounded concurrency and resumable in-memory task state. */
class TransferQueue(private val scope: CoroutineScope, maxConcurrent: Int = 3) {
    private val permits = Semaphore(maxConcurrent)
    private val mutableTasks = MutableStateFlow<List<TransferTask>>(emptyList())
    val tasks: StateFlow<List<TransferTask>> = mutableTasks
    private val jobs = mutableMapOf<String, Job>()
    private val paused = mutableSetOf<String>()

    fun enqueueUpload(remotePath: String, data: ByteArray, channel: SftpChannel): String {
        val id = UUID.randomUUID().toString()
        update(TransferTask(id, remotePath, data.size.toLong()))
        jobs[id] = scope.launch {
            permits.withPermit {
                try {
                    update(find(id).copy(state = TransferState.RUNNING))
                    var offset = 0
                    val chunkSize = 32 * 1024
                    while (offset < data.size) {
                        while (id in paused) {
                            update(find(id).copy(state = TransferState.PAUSED))
                            delay(100)
                        }
                        val end = minOf(offset + chunkSize, data.size)
                        channel.writeChunk(remotePath, data.copyOfRange(offset, end), offset.toLong(), truncate = offset == 0)
                        offset = end
                        update(find(id).copy(bytesTransferred = offset.toLong(), state = TransferState.RUNNING))
                    }
                    update(find(id).copy(bytesTransferred = data.size.toLong(), state = TransferState.COMPLETED))
                } catch (_: CancellationException) {
                    update(find(id).copy(state = TransferState.CANCELED))
                } catch (error: Throwable) {
                    update(find(id).copy(state = TransferState.FAILED, error = error.message))
                }
            }
        }
        return id
    }

    fun pause(id: String) {
        if (jobs.containsKey(id)) paused += id
    }

    fun resume(id: String) {
        paused -= id
        tasks.value.firstOrNull { it.id == id }?.let { update(it.copy(state = TransferState.RUNNING)) }
    }

    fun cancel(id: String) {
        paused -= id
        jobs.remove(id)?.cancel()
    }

    private fun find(id: String): TransferTask = tasks.value.first { it.id == id }

    private fun update(task: TransferTask) {
        mutableTasks.value = mutableTasks.value.map { if (it.id == task.id) task else it }
            .let { current -> if (current.any { it.id == task.id }) current else current + task }
    }
}
