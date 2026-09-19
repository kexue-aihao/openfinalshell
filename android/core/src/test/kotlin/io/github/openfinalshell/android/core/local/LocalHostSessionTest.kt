package io.github.openfinalshell.android.core.local

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Exercises the protocol against an in-memory host that speaks it.
 *
 * Complementary to the instrumented test, which drives the real native helper: this one runs
 * anywhere, runs fast, and is the place where the awkward cases — a host that never answers the
 * handshake, output that arrives before anyone collects it, an exit frame with no prior data — are
 * pinned.
 */
class LocalHostSessionTest {
    /** A duplex in-memory carrier, so the session sees chunks exactly as a socket would deliver them. */
    private class Pipe(private val scope: CoroutineScope, private val ackHandshake: Boolean) : LocalHostStream {
        private val toClient = Channel<ByteArray>(Channel.UNLIMITED)
        private val fromClient = Channel<ByteArray>(Channel.UNLIMITED)
        private val decoder = LocalHostCodec.Decoder()

        val sawHello = CompletableDeferred<String>()
        val resizes = mutableListOf<Pair<Int, Int>>()
        val inputs = mutableListOf<ByteArray>()
        val closed = AtomicBoolean(false)

        init {
            scope.launch {
                for (chunk in fromClient) {
                    for (frame in decoder.feed(chunk)) {
                        when (frame.type) {
                            LocalHostCodec.TYPE_HELLO -> {
                                sawHello.complete(String(frame.payload, Charsets.ISO_8859_1))
                                if (ackHandshake) toClient.send(LocalHostCodec.encode(LocalHostCodec.TYPE_ACK))
                            }
                            LocalHostCodec.TYPE_INPUT -> {
                                inputs += frame.payload
                                toClient.send(LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, "ECHO:".toByteArray() + frame.payload))
                            }
                            LocalHostCodec.TYPE_RESIZE -> resizes += LocalHostCodec.decodeResize(frame.payload)
                            LocalHostCodec.TYPE_CLOSE -> {
                                closed.set(true)
                                toClient.send(LocalHostCodec.encodeExit(0))
                                toClient.close()
                            }
                        }
                    }
                }
            }
        }

        /** Emits host-side data, e.g. to check that pre-collection output is not lost. */
        suspend fun emit(bytes: ByteArray) = toClient.send(LocalHostCodec.encode(LocalHostCodec.TYPE_DATA, bytes))

        override fun incoming(): Flow<ByteArray> = toClient.receiveAsFlow()
        override suspend fun send(bytes: ByteArray) { fromClient.send(bytes) }
        override suspend fun close() { toClient.close(); fromClient.close() }
    }

    private fun scope() = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @Test fun handshakePresentsTheTokenAndWaitsForAck() = runBlocking<Unit> {
        val scope = scope()
        val pipe = Pipe(scope, ackHandshake = true)
        val session = LocalHostSession(pipe, scope)
        val token = LocalHostCodec.newToken()
        session.handshake(token, timeoutMs = 2_000)
        // The host sees the decoded token bytes, not the hex string.
        assertArrayEquals(LocalHostCodec.tokenBytes(token), pipe.sawHello.await().toByteArray(Charsets.ISO_8859_1))
        session.close()
        scope.cancel()
    }

    /** A host that never answers must fail the connect, not hang it. */
    @Test fun handshakeTimesOutWhenTheHostNeverAcknowledges() {
        val scope = scope()
        val pipe = Pipe(scope, ackHandshake = false)
        val session = LocalHostSession(pipe, scope)
        assertThrows(kotlinx.coroutines.TimeoutCancellationException::class.java) {
            runBlocking { session.handshake(LocalHostCodec.newToken(), timeoutMs = 200) }
        }
    }

    /**
     * Collects output in the background and polls for a needle.
     *
     * Deliberately not "collect and throw to stop": a CancellationException raised inside a collect
     * cancels the collector, and `withTimeoutOrNull` does not catch it, so the test would fail
     * rather than end early.
     */
    private fun CoroutineScope.collectOutput(session: LocalHostSession): StringBuilder {
        val builder = StringBuilder()
        launch { session.output.collect { builder.append(String(it, Charsets.UTF_8)) } }
        return builder
    }

    private suspend fun awaitText(builder: StringBuilder, needle: String, timeoutMs: Long = 2_000): String {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (builder.contains(needle)) break
            kotlinx.coroutines.delay(20)
        }
        return builder.toString()
    }

    @Test fun inputIsForwardedAndHostOutputArrives() = runBlocking<Unit> {
        val scope = scope()
        val session = LocalHostSession(Pipe(scope, ackHandshake = true), scope)
        session.handshake(LocalHostCodec.newToken(), timeoutMs = 2_000)
        val collected = scope.collectOutput(session)
        session.sendInput("ls\n".toByteArray())
        val seen = awaitText(collected, "ECHO:ls")
        assertTrue("expected the echoed input; saw: $seen", seen.contains("ECHO:ls"))
        session.close()
        scope.cancel()
    }

    /**
     * Output produced before anyone collects it must survive.
     *
     * The shell prints its prompt immediately, while the caller only collects after the channel has
     * been handed back. A shared flow with no subscriber would drop exactly that.
     */
    @Test fun outputArrivingBeforeCollectionIsBuffered() = runBlocking<Unit> {
        val scope = scope()
        val pipe = Pipe(scope, ackHandshake = true)
        val session = LocalHostSession(pipe, scope)
        session.handshake(LocalHostCodec.newToken(), timeoutMs = 2_000)
        pipe.emit("early prompt".toByteArray())
        // Give the reader a chance to decode it before anything collects.
        kotlinx.coroutines.delay(50)
        val collected = scope.collectOutput(session)
        val seen = awaitText(collected, "early prompt")
        assertTrue("the pre-collection prompt was lost; saw: $seen", seen.contains("early prompt"))
        session.close()
        scope.cancel()
    }

    @Test fun resizeIsForwardedWithRowsThenColumns() = runBlocking {
        val scope = scope()
        val pipe = Pipe(scope, ackHandshake = true)
        val session = LocalHostSession(pipe, scope)
        session.handshake(LocalHostCodec.newToken(), timeoutMs = 2_000)
        session.resize(rows = 12, cols = 40)
        kotlinx.coroutines.delay(100)
        assertEquals(listOf(12 to 40), pipe.resizes)
    }

    @Test fun theExitFrameCarriesTheShellStatus() = runBlocking {
        val scope = scope()
        val pipe = Pipe(scope, ackHandshake = true)
        val session = LocalHostSession(pipe, scope)
        session.handshake(LocalHostCodec.newToken(), timeoutMs = 2_000)
        session.close()
        assertTrue("close must tell the host to hang up", pipe.closed.get())
        assertEquals(0, session.exited.await())
    }

    /**
     * A stream that ends without an exit frame still has to release the waiter: the host died, and
     * the shell is gone either way.
     */
    @Test fun aStreamEndingWithoutAnExitFrameStillCompletes() = runBlocking {
        val scope = scope()
        val pipe = Pipe(scope, ackHandshake = true)
        val session = LocalHostSession(pipe, scope)
        session.handshake(LocalHostCodec.newToken(), timeoutMs = 2_000)
        pipe.close()
        assertEquals(-1, session.exited.await())
    }

    @Test fun anUnknownFrameTypeIsIgnoredRatherThanFatal() = runBlocking<Unit> {
        val scope = scope()
        val pipe = Pipe(scope, ackHandshake = true)
        val session = LocalHostSession(pipe, scope)
        session.handshake(LocalHostCodec.newToken(), timeoutMs = 2_000)
        // An empty data frame is the smallest thing a newer host could send that this decoder has no
        // use for; it must be ignored rather than treated as a protocol error.
        pipe.emit(ByteArray(0))
        val collected = scope.collectOutput(session)
        session.sendInput("still alive\n".toByteArray())
        val seen = awaitText(collected, "ECHO:still alive")
        assertTrue("the session must survive an empty data frame; saw: $seen", seen.contains("ECHO:still alive"))
        session.close()
        scope.cancel()
    }

    @Test fun theArgvContractMatchesWhatTheHostExpects() {
        val request = HostRequest(
            shellPath = "/system/bin/sh",
            workingDirectory = "/data/local/tmp",
            environment = arrayOf("HOME=/data", "TERM=xterm-256color"),
            token = "ab".repeat(32),
            cols = 80,
            rows = 24,
            command = "id -u"
        )
        val args = LocalHostArgs.build(request).toList()
        // --port 0 asks the host to pick one, which removes the race a caller-chosen port would have.
        assertEquals("0", args[args.indexOf("--port") + 1])
        assertEquals(request.token, args[args.indexOf("--token") + 1])
        assertEquals("exec", args[args.indexOf("--mode") + 1])
        assertEquals("id -u", args[args.indexOf("--command") + 1])
        // Both environment entries travel, each behind its own flag.
        assertEquals(2, args.count { it == "--env" })
        assertEquals(41234, LocalHostArgs.parsePort("PORT 41234"))
        assertEquals(null, LocalHostArgs.parsePort(""))
        assertEquals(null, LocalHostArgs.parsePort("PORT not-a-number"))
    }
}
