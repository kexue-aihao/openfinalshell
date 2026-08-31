package io.github.openfinalshell.android.core.ssh

import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.SessionState
import java.io.ByteArrayInputStream
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.apache.sshd.client.SshClient
import org.apache.sshd.client.session.ClientSession
import org.apache.sshd.client.keyverifier.AcceptAllServerKeyVerifier
import org.apache.sshd.common.config.keys.FilePasswordProvider
import org.apache.sshd.sftp.client.SftpClientFactory

/** Apache MINA SSHD connection adapter. Channel adapters are isolated behind SshTransport. */
class MinaSshTransport(
    private val hostKeyVerifier: HostKeyVerifier? = null
) : SshTransport {
    private val mutableState = MutableStateFlow(SessionState.CLOSED)
    override val state: StateFlow<SessionState> = mutableState
    private val mutableEvents = MutableSharedFlow<TransportEvent>(extraBufferCapacity = 8)
    override val events: SharedFlow<TransportEvent> = mutableEvents.asSharedFlow()
    private var client: SshClient? = null
    private var session: ClientSession? = null
    private var intentionalClose = false

    override suspend fun connect(profile: ConnectionProfile, credentials: Credentials) {
        require(profile.port in 1..65535) { "invalid SSH port" }
        check(session == null) { "SSH session is already connected" }
        intentionalClose = false
        mutableState.value = SessionState.CONNECTING
        val ssh = SshClient.setUpDefaultClient()
        ssh.serverKeyVerifier = if (hostKeyVerifier == null) {
            // Temporary prototype fallback. Replace with Android TOFU confirmation before release.
            AcceptAllServerKeyVerifier.INSTANCE
        } else {
            org.apache.sshd.client.keyverifier.ServerKeyVerifier { _, _, key ->
                runBlocking { hostKeyVerifier.verify(profile.host, profile.port, key) }
            }
        }
        ssh.start()
        client = ssh
        mutableState.value = SessionState.AUTHENTICATING
        var connected: ClientSession? = null
        try {
            connected = ssh.connect(profile.username, profile.host, profile.port).verify().session
            credentials.password?.let { connected.addPasswordIdentity(String(it)) }
            // Key parsing is delegated to Apache MINA's parser so OpenSSH/PEM formats remain supported.
            credentials.privateKey?.let { keyBytes ->
                val parser = org.apache.sshd.common.util.security.SecurityUtils.getKeyPairResourceParser()
                val passwordProvider = credentials.passphrase?.let { FilePasswordProvider.of(String(it)) }
                parser.loadKeyPairs(null, null, passwordProvider, ByteArrayInputStream(keyBytes))
                    .forEach { connected.addPublicKeyIdentity(it) }
            }
            connected.auth().verify()
            session = connected
            connected.addCloseFutureListener {
                if (!intentionalClose && session === connected) {
                    session = null
                    mutableState.value = SessionState.CLOSED
                    mutableEvents.tryEmit(TransportEvent.Disconnected())
                }
            }
            mutableState.value = SessionState.READY
        } catch (error: Throwable) {
            connected?.close(false)
            ssh.stop()
            client = null
            session = null
            mutableState.value = SessionState.CLOSED
            throw error
        }
    }

    override suspend fun openShell(cols: Int, rows: Int): ShellChannel =
        checkNotNull(session) { "SSH session is not connected" }.let { current ->
            val channel = current.createShellChannel()
            channel.setPtyType("xterm-256color")
            channel.setPtyColumns(cols)
            channel.setPtyLines(rows)
            channel.open().verify()
            MinaShellChannel(channel)
        }

    override suspend fun openExec(command: String): ExecChannel {
        require(command.isNotBlank()) { "exec command must not be blank" }
        val current = checkNotNull(session) { "SSH session is not connected" }
        val channel = current.createExecChannel(command)
        channel.open().verify()
        return MinaExecChannel(channel)
    }

    override suspend fun openSftp(): SftpChannel =
        MinaSftpChannel(
            SftpClientFactory.instance().createSftpClient(checkNotNull(session) { "SSH session is not connected" })
        )

    override suspend fun disconnect() {
        intentionalClose = true
        session?.close(false)
        client?.stop()
        session = null
        client = null
        mutableState.value = SessionState.CLOSED
    }
}
