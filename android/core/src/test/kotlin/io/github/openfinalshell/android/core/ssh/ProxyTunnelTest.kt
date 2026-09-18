package io.github.openfinalshell.android.core.ssh

import io.github.openfinalshell.android.core.model.ConnectionProxy
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class ProxyTunnelTest {
    @Test fun httpConnectPreservesBytesAfterHeaderAndAuthenticates() {
        ServerSocket(0).use { server ->
            val executor = Executors.newSingleThreadExecutor()
            val peer = executor.submit {
                server.accept().use { socket ->
                    socket.soTimeout = 3000
                    val input = socket.getInputStream()
                    val header = StringBuilder()
                    while (!header.endsWith("\r\n\r\n")) header.append(input.read().toChar())
                    assertTrue(header.startsWith("CONNECT example.test:22 HTTP/1.1"))
                    assertTrue(header.contains("Proxy-Authorization: Basic dXNlcjpwYXNz"))
                    socket.getOutputStream().write("HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-test\r\n".toByteArray())
                    assertEquals(42, input.read())
                }
            }
            try {
                ProxyTunnel.open(ConnectionProxy("http", "127.0.0.1", server.localPort, "user"), "example.test", 22, "pass".toCharArray(), 3000).use { tunnel ->
                    Socket("127.0.0.1", tunnel.port).use { socket ->
                        socket.soTimeout = 3000
                        assertEquals("SSH-2.0-test", socket.getInputStream().bufferedReader().readLine())
                        socket.getOutputStream().write(42)
                        // 等对端读到这个字节再退出 use（= 关隧道）。
                        // close() 会立刻关掉上游 socket 并打断转发线程：客户端→代理那一个字节要由
                        // 转发线程 copyTo 搬过去，主线程先关上游时那次 write 撞上 "Socket closed"，
                        // 字节就没了。原写法把 peer.get() 放在关隧道之后，等于赌转发线程先跑完 ——
                        // CI 慢机上真输过（v0.30.26 的 android-release 就是这么挂的）。
                        peer.get(5, TimeUnit.SECONDS)
                    }
                }
            } finally { executor.shutdownNow() }
        }
    }

    @Test fun socks5SendsTargetHostnameToProxy() {
        ServerSocket(0).use { server ->
            val executor = Executors.newSingleThreadExecutor()
            val peer = executor.submit {
                server.accept().use { socket ->
                    socket.soTimeout = 3000
                    val input = socket.getInputStream()
                    assertEquals(listOf(5, 1, 2), List(3) { input.read() })
                    socket.getOutputStream().write(byteArrayOf(5, 2))
                    assertEquals(1, input.read())
                    val username = ByteArray(input.read()).also { input.read(it) }
                    val secret = ByteArray(input.read()).also { input.read(it) }
                    assertEquals("user", username.toString(Charsets.UTF_8)); assertEquals("pass", secret.toString(Charsets.UTF_8))
                    socket.getOutputStream().write(byteArrayOf(1, 0))
                    assertEquals(listOf(5, 1, 0, 3), List(4) { input.read() })
                    assertEquals("not-resolved.invalid", ByteArray(input.read()).also { input.read(it) }.toString(Charsets.UTF_8))
                    assertEquals(listOf(0, 22), List(2) { input.read() })
                    socket.getOutputStream().write(byteArrayOf(5, 0, 0, 1, 127, 0, 0, 1, 0, 22))
                    socket.getOutputStream().write(42)
                    input.read()
                }
            }
            try {
                ProxyTunnel.open(ConnectionProxy("socks5", "127.0.0.1", server.localPort, "user"), "not-resolved.invalid", 22, "pass".toCharArray(), 3000).use { tunnel ->
                    Socket("127.0.0.1", tunnel.port).use { socket -> socket.soTimeout = 3000; assertEquals(42, socket.getInputStream().read()) }
                }
                peer.get(5, TimeUnit.SECONDS)
            } finally { executor.shutdownNow() }
        }
    }

    @Test fun rejectedProxyCannotFallBackToTarget() {
        ServerSocket(0).use { server ->
            val executor = Executors.newSingleThreadExecutor()
            val peer = executor.submit {
                server.accept().use { socket ->
                    val header = StringBuilder()
                    while (!header.endsWith("\r\n\r\n")) header.append(socket.getInputStream().read().toChar())
                    socket.getOutputStream().write("HTTP/1.1 407 Authentication required\r\n\r\n".toByteArray())
                }
            }
            try {
                assertThrows(IllegalStateException::class.java) {
                    ProxyTunnel.open(ConnectionProxy("http", "127.0.0.1", server.localPort), "not-resolved.invalid", 22, null, 3000)
                }
                peer.get(5, TimeUnit.SECONDS)
            } finally { executor.shutdownNow() }
        }
    }
}
