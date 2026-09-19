package io.github.openfinalshell.android.core.local

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/**
 * The protocol client for one privileged host process.
 *
 * Owns the handshake, the frame decoding and the lifetime of a single host, so the transport above
 * only has to speak in input, resize, output and exit.
 */
class LocalHostSession(private val stream: LocalHostStream, private val scope: CoroutineScope) {
    private val decoder = LocalHostCodec.Decoder()

    /**
     * Unbounded and channel-backed, not a shared flow.
     *
     * The caller collects output only after the channel has been handed back, so the shell's first
     * prompt — and anything else printed before the collector attaches — would be dropped by a
     * shared flow with no subscriber. A channel keeps it until someone reads.
     */
    private val outputChannel = Channel<ByteArray>(Channel.UNLIMITED)
    val output: Flow<ByteArray> = outputChannel.receiveAsFlow()

    private val acknowledged = CompletableDeferred<Unit>()
    private val exitStatus = CompletableDeferred<Int>()
    private var reader: Job? = null

    /** Completes with the shell's wait status, or -1 when the stream ended without one. */
    val exited: Deferred<Int> get() = exitStatus

    /**
     * Presents the token and waits for the host to accept it.
     *
     * The handshake is the only authentication: loopback TCP is reachable by any process on the
     * device, so an unacknowledged connection is treated as a failure rather than as a slow start.
     */
    suspend fun handshake(token: String, timeoutMs: Long = HANDSHAKE_TIMEOUT_MS) {
        reader = scope.launch { readLoop() }
        try {
            stream.send(LocalHostCodec.encode(LocalHostCodec.TYPE_HELLO, LocalHostCodec.tokenBytes(token)))
            withTimeout(timeoutMs) { acknowledged.await() }
        } catch (error: Throwable) {
            // A host that never answers must not leave a reader holding the stream open.
            runCatching { close() }
            throw error
        }
    }

    suspend fun sendInput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        stream.send(LocalHostCodec.encode(LocalHostCodec.TYPE_INPUT, bytes))
    }

    suspend fun resize(rows: Int, cols: Int) {
        stream.send(LocalHostCodec.encodeResize(rows, cols))
    }

    /** Asks the host to hang up its shell and releases the stream. */
    suspend fun close() {
        runCatching { stream.send(LocalHostCodec.encode(LocalHostCodec.TYPE_CLOSE)) }
        reader?.cancel()
        outputChannel.close()
        runCatching { stream.close() }
        if (!exitStatus.isCompleted) exitStatus.complete(UNKNOWN_EXIT)
    }

    private suspend fun readLoop() {
        try {
            stream.incoming().collect { chunk ->
                for (frame in decoder.feed(chunk)) {
                    when (frame.type) {
                        LocalHostCodec.TYPE_ACK -> acknowledged.complete(Unit)
                        LocalHostCodec.TYPE_DATA -> outputChannel.send(frame.payload)
                        LocalHostCodec.TYPE_EXIT -> exitStatus.complete(LocalHostCodec.decodeExit(frame.payload))
                        // Unknown types are ignored rather than fatal, so a newer host that adds one
                        // does not break an older app.
                        else -> Unit
                    }
                }
            }
        } catch (error: Throwable) {
            acknowledged.completeExceptionally(error)
            exitStatus.completeExceptionally(error)
        } finally {
            outputChannel.close()
            // A stream that ends without an exit frame means the host died; the shell is gone either
            // way, and the transport needs to hear about it rather than wait forever.
            if (!exitStatus.isCompleted) exitStatus.complete(UNKNOWN_EXIT)
        }
    }

    companion object {
        private const val HANDSHAKE_TIMEOUT_MS = 10_000L
        private const val UNKNOWN_EXIT = -1
    }
}
