package io.github.openfinalshell.android.core.ssh

import io.github.openfinalshell.android.core.model.ConnectionProxy
import java.io.EOFException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** One authenticated proxy tunnel per SSH transport; never falls back to a direct connection. */
class ProxyTunnel private constructor(private val upstream: Socket) : AutoCloseable {
    private val listener = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    private val executor = Executors.newFixedThreadPool(2) { Thread(it, "ssh-proxy-tunnel").apply { isDaemon = true } }
    private val closed = AtomicBoolean(false)
    @Volatile private var downstream: Socket? = null
    val port: Int = listener.localPort

    init {
        listener.soTimeout = 20_000
        executor.execute {
            try {
                val local = listener.accept()
                downstream = local
                listener.close()
                if (closed.get()) { local.close(); return@execute }
                executor.execute { pump(local, upstream) }
                pump(upstream, local)
            } catch (_: Exception) { close() }
        }
    }

    private fun pump(from: Socket, to: Socket) {
        try { from.getInputStream().copyTo(to.getOutputStream(), 32 * 1024) }
        catch (_: Exception) { /* The SSH session owns user-visible disconnect reporting. */ }
        finally { close() }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { listener.close() }
        runCatching { downstream?.close() }
        runCatching { upstream.close() }
        executor.shutdownNow()
    }

    companion object {
        fun open(proxy: ConnectionProxy, targetHost: String, targetPort: Int, password: CharArray?, timeoutMs: Int): ProxyTunnel {
            require(targetPort in 1..65535 && targetHost.isNotBlank() && targetHost.none { it.isWhitespace() || it == '\u0000' })
            val socket = Socket()
            try {
                socket.connect(InetSocketAddress(requireNotNull(proxy.host), requireNotNull(proxy.port)), timeoutMs)
                socket.soTimeout = timeoutMs
                when (proxy.type.lowercase()) {
                    "http" -> connectHttp(socket, targetHost, targetPort, proxy.username, password)
                    "socks5" -> connectSocks(socket, targetHost, targetPort, proxy.username, password)
                    else -> error("unsupported proxy type")
                }
                socket.soTimeout = 0
                return ProxyTunnel(socket)
            } catch (error: Exception) { socket.close(); throw error }
        }

        internal fun connectHttp(socket: Socket, host: String, port: Int, username: String?, password: CharArray?) {
            val authority = if (host.contains(':')) "[${host.removeSurrounding("[", "]")}]:$port" else "$host:$port"
            val auth = username?.takeIf { it.isNotEmpty() }?.let {
                require(!it.contains(':'))
                "Proxy-Authorization: Basic " + Base64.getEncoder().encodeToString("$it:${password?.concatToString().orEmpty()}".toByteArray(Charsets.UTF_8)) + "\r\n"
            }.orEmpty()
            socket.getOutputStream().write("CONNECT $authority HTTP/1.1\r\nHost: $authority\r\n${auth}\r\n".toByteArray(Charsets.UTF_8))
            val header = StringBuilder()
            val input = socket.getInputStream()
            while (!header.endsWith("\r\n\r\n")) {
                require(header.length < 16 * 1024) { "proxy response too large" }
                header.append(input.readByte().toChar())
            }
            val status = Regex("^HTTP/1\\.[01] ([0-9]{3})(?: |\\r)").find(header)?.groupValues?.get(1)?.toInt()
            check(status in 200..299) { "HTTP proxy refused tunnel (${status ?: 0})" }
        }

        internal fun connectSocks(socket: Socket, host: String, port: Int, username: String?, password: CharArray?) {
            val output = socket.getOutputStream()
            val input = socket.getInputStream()
            val authenticated = !username.isNullOrEmpty()
            output.write(byteArrayOf(5, 1, if (authenticated) 2 else 0))
            check(input.readByte() == 5 && input.readByte() == if (authenticated) 2 else 0) { "SOCKS proxy authentication method refused" }
            if (authenticated) {
                val user = username!!.toByteArray(Charsets.UTF_8)
                val secret = password?.concatToString().orEmpty().toByteArray(Charsets.UTF_8)
                require(user.size in 1..255 && secret.size in 1..255) { "invalid SOCKS credentials length" }
                try { output.write(byteArrayOf(1, user.size.toByte()) + user + byteArrayOf(secret.size.toByte()) + secret) }
                finally { secret.fill(0) }
                check(input.readByte() == 1 && input.readByte() == 0) { "SOCKS proxy authentication refused" }
            }
            val literal = host.removeSurrounding("[", "]")
            val address = if (literal.contains(':') || Regex("^[0-9]+(?:\\.[0-9]+){3}$").matches(literal)) {
                val bytes = InetAddress.getByName(literal).address
                byteArrayOf(if (bytes.size == 16) 4 else 1) + bytes
            } else {
                val name = java.net.IDN.toASCII(host).toByteArray(Charsets.US_ASCII)
                require(name.size in 1..255)
                byteArrayOf(3, name.size.toByte()) + name
            }
            output.write(byteArrayOf(5, 1, 0) + address + byteArrayOf((port ushr 8).toByte(), port.toByte()))
            check(input.readByte() == 5 && input.readByte() == 0) { "SOCKS proxy refused tunnel" }
            check(input.readByte() == 0)
            val length = when (input.readByte()) { 1 -> 4; 4 -> 16; 3 -> input.readByte(); else -> error("invalid SOCKS address") }
            repeat(length + 2) { input.readByte() }
        }

        private fun InputStream.readByte(): Int = read().also { if (it < 0) throw EOFException("proxy closed tunnel") }
    }
}
