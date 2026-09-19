package io.github.openfinalshell.android.core.local

import java.net.InetSocketAddress
import java.net.Socket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext

/**
 * The loopback carrier to a host process.
 *
 * Loopback TCP rather than an abstract UNIX socket, deliberately: an abstract socket would need a
 * SELinux `unix_stream_socket connectto` exemption between the host's domain (`shell`, `magisk`) and
 * `untrusted_app`, which no app can grant itself. `INTERNET` is already declared, and the only
 * exposure loopback brings — another app racing to connect to the port — is closed by the 32-byte
 * token and a host that accepts exactly one connection.
 */
class SocketLocalHostStream(private val socket: Socket) : LocalHostStream {
    constructor(port: Int, timeoutMs: Int = CONNECT_TIMEOUT_MS) : this(
        Socket().apply {
            tcpNoDelay = true
            connect(InetSocketAddress("127.0.0.1", port), timeoutMs)
        }
    )

    override fun incoming(): Flow<ByteArray> = flow {
        val input = socket.getInputStream()
        val buffer = ByteArray(READ_BUFFER)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (read > 0) emit(buffer.copyOf(read))
        }
    }.flowOn(Dispatchers.IO)

    override suspend fun send(bytes: ByteArray) = withContext(Dispatchers.IO) {
        val output = socket.getOutputStream()
        output.write(bytes)
        // Terminal input is interactive: a buffered write would hold a keystroke until the next one.
        output.flush()
    }

    override suspend fun close() {
        withContext(Dispatchers.IO) { runCatching { socket.close() } }
    }

    private companion object {
        const val READ_BUFFER = 8 * 1024
        const val CONNECT_TIMEOUT_MS = 5_000
    }
}
