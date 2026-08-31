package io.github.openfinalshell.android.core.forward

import io.github.openfinalshell.android.core.model.ForwardRule
import java.net.ServerSocket
import java.net.Socket
import java.net.InetAddress
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

interface ForwardDialer {
    suspend fun open(host: String, port: Int): Socket
}

/** Local forwarding implementation. Remote and dynamic modes use the same dialer contract. */
class LocalForwarder(private val dialer: ForwardDialer) {
    private val workers = Executors.newCachedThreadPool()
    private var listener: ServerSocket? = null

    suspend fun start(rule: ForwardRule) = withContext(Dispatchers.IO) {
        require(rule.type == "local") { "LocalForwarder only accepts local rules" }
        val destinationHost = rule.dstHost ?: error("local forward destination is required")
        val destinationPort = rule.dstPort ?: error("local forward destination is required")
        val server = ServerSocket(rule.bindPort, 50, java.net.InetAddress.getByName(rule.bindAddr))
        listener = server
        workers.submit {
            while (!server.isClosed) {
                try {
                    val inbound = server.accept()
                    workers.submit {
                        try {
                            val outbound = kotlinx.coroutines.runBlocking { dialer.open(destinationHost, destinationPort) }
                            pipe(inbound, outbound)
                        } finally {
                            inbound.close()
                        }
                    }
                } catch (_: Exception) {
                    if (!server.isClosed) break
                }
            }
        }
    }

    fun stop() {
        listener?.close()
        listener = null
    }

    private fun pipe(left: Socket, right: Socket) {
        val a = workers.submit { left.getInputStream().copyTo(right.getOutputStream()); right.shutdownOutput() }
        val b = workers.submit { right.getInputStream().copyTo(left.getOutputStream()); left.shutdownOutput() }
        a.get()
        b.get()
        right.close()
    }
}

data class Socks5Request(val host: String, val port: Int)

/** No-auth SOCKS5 CONNECT parser matching the desktop dynamic forward implementation. */
object Socks5Parser {
    fun greeting(bytes: ByteArray): Boolean = bytes.size >= 3 &&
        bytes[0].toInt() == 5 && (0 until bytes[1].toInt()).any { bytes[2 + it].toInt() == 0 }

    fun connect(bytes: ByteArray): Socks5Request {
        require(bytes.size >= 7 && bytes[0].toInt() == 5 && bytes[1].toInt() == 1) { "unsupported SOCKS5 request" }
        val addressType = bytes[3].toInt()
        var offset = 4
        val host = when (addressType) {
            1 -> {
                require(bytes.size >= offset + 4)
                val address = bytes.copyOfRange(offset, offset + 4)
                offset += 4
                InetAddress.getByAddress(address).hostAddress
            }
            3 -> {
                val length = bytes[offset++].toInt() and 0xff
                require(bytes.size >= offset + length)
                String(bytes, offset, length, Charsets.UTF_8).also { offset += length }
            }
            4 -> {
                require(bytes.size >= offset + 16)
                val address = bytes.copyOfRange(offset, offset + 16)
                offset += 16
                InetAddress.getByAddress(address).hostAddress
            }
            else -> error("unsupported SOCKS5 address type")
        }
        require(bytes.size >= offset + 2)
        val port = ByteBuffer.wrap(bytes, offset, 2).order(ByteOrder.BIG_ENDIAN).short.toInt() and 0xffff
        return Socks5Request(host, port)
    }

    fun successReply(): ByteArray = byteArrayOf(5, 0, 0, 1, 0, 0, 0, 0, 0, 0)
    fun failureReply(): ByteArray = byteArrayOf(5, 1, 0, 1, 0, 0, 0, 0, 0, 0)
}

class DynamicSocksForwarder(private val dialer: ForwardDialer) {
    private val workers = Executors.newCachedThreadPool()
    private var listener: ServerSocket? = null

    fun start(bindAddr: String, bindPort: Int) {
        val server = ServerSocket(bindPort, 50, InetAddress.getByName(bindAddr))
        listener = server
        workers.submit {
            while (!server.isClosed) {
                try {
                    val client = server.accept()
                    workers.submit { handle(client) }
                } catch (_: Exception) {
                    if (!server.isClosed) break
                }
            }
        }
    }

    fun stop() {
        listener?.close()
        listener = null
    }

    private fun handle(client: Socket) {
        client.use { inbound ->
            val input = inbound.getInputStream()
            val output = inbound.getOutputStream()
            val greeting = input.readNBytes(2)
            if (greeting.size != 2 || greeting[0].toInt() != 5) return
            val methods = input.readNBytes(greeting[1].toInt() and 0xff)
            if (!Socks5Parser.greeting(greeting + methods)) {
                output.write(byteArrayOf(5, 0xff.toByte())); return
            }
            output.write(byteArrayOf(5, 0)); output.flush()
            val head = input.readNBytes(4)
            if (head.size != 4) return
            val addressLength = when (head[3].toInt()) {
                1 -> 4
                3 -> input.read()
                4 -> 16
                else -> -1
            }
            if (addressLength <= 0) { output.write(Socks5Parser.failureReply()); return }
            val address = if (head[3].toInt() == 3) byteArrayOf(addressLength.toByte()) + input.readNBytes(addressLength) else input.readNBytes(addressLength)
            val request = Socks5Parser.connect(head + address + input.readNBytes(2))
            try {
                val outbound = kotlinx.coroutines.runBlocking { dialer.open(request.host, request.port) }
                output.write(Socks5Parser.successReply()); output.flush()
                pipe(inbound, outbound)
                outbound.close()
            } catch (_: Exception) {
                output.write(Socks5Parser.failureReply()); output.flush()
            }
        }
    }

    private fun pipe(left: Socket, right: Socket) {
        val a = workers.submit { left.getInputStream().copyTo(right.getOutputStream()); right.shutdownOutput() }
        val b = workers.submit { right.getInputStream().copyTo(left.getOutputStream()); left.shutdownOutput() }
        a.get(); b.get()
    }
}

/** Remote forwarding is implemented by the SSH transport adapter, not by local sockets. */
interface RemoteForwarder {
    suspend fun start(rule: ForwardRule)
    suspend fun stop(rule: ForwardRule)
}

data class ForwardRuntimeState(
    val ruleId: String,
    val state: String = "stopped",
    val activeConnections: Int = 0,
    val totalBytes: Long = 0,
    val error: String? = null
)

/** Owns local, dynamic and remote forwarding lifecycles independently of Compose. */
class ForwardingManager(
    private val dialer: ForwardDialer,
    private val remote: RemoteForwarder? = null
) {
    private val mutableStates = MutableStateFlow<Map<String, ForwardRuntimeState>>(emptyMap())
    val states: StateFlow<Map<String, ForwardRuntimeState>> = mutableStates
    private val local = mutableMapOf<String, LocalForwarder>()
    private val dynamic = mutableMapOf<String, DynamicSocksForwarder>()
    private val remoteRules = mutableMapOf<String, ForwardRule>()

    suspend fun start(rule: ForwardRule) {
        stop(rule.id)
        try {
            when (rule.type.lowercase()) {
                "local" -> LocalForwarder(dialer).also { it.start(rule); local[rule.id] = it }
                "dynamic" -> DynamicSocksForwarder(dialer).also { it.start(rule.bindAddr, rule.bindPort); dynamic[rule.id] = it }
                "remote" -> {
                    remote?.start(rule) ?: error("remote forwarding is not available for this session")
                    remoteRules[rule.id] = rule
                }
                else -> error("unsupported forwarding type: ${rule.type}")
            }
            update(rule.id, ForwardRuntimeState(rule.id, "active"))
        } catch (error: Throwable) {
            update(rule.id, ForwardRuntimeState(rule.id, "error", error = error.message ?: error.javaClass.simpleName))
            throw error
        }
    }

    suspend fun stop(ruleId: String) {
        local.remove(ruleId)?.stop()
        dynamic.remove(ruleId)?.stop()
        remoteRules.remove(ruleId)?.let { remote?.stop(it) }
        mutableStates.value[ruleId]?.let { current ->
            update(ruleId, current.copy(state = "stopped", activeConnections = 0))
        }
    }

    suspend fun stopAll() {
        (local.keys + dynamic.keys + remoteRules.keys).toList().forEach { stop(it) }
    }

    private fun update(id: String, state: ForwardRuntimeState) {
        mutableStates.value = mutableStates.value + (id to state)
    }
}
