package io.github.openfinalshell.android.core.ssh

import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.SessionState
import java.io.ByteArrayInputStream
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.apache.sshd.client.SshClient
import org.apache.sshd.client.session.ClientSession
import org.apache.sshd.common.config.keys.FilePasswordProvider
import org.apache.sshd.sftp.client.SftpClientFactory

/** Apache MINA SSHD connection adapter. Channel adapters are isolated behind SshTransport. */
class MinaSshTransport : SshTransport {
    private val mutableState = MutableStateFlow(SessionState.CLOSED)
    override val state: StateFlow<SessionState> = mutableState
    private var client: SshClient? = null
    private var session: ClientSession? = null

    override suspend fun connect(profile: ConnectionProfile, credentials: Credentials) {
        require(profile.port in 1..65535) { "invalid SSH port" }
        mutableState.value = SessionState.CONNECTING
        val ssh = SshClient.setUpDefaultClient()
        ssh.start()
        client = ssh
        mutableState.value = SessionState.AUTHENTICATING
        val connected = ssh.connect(profile.username, profile.host, profile.port).verify().session
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
        mutableState.value = SessionState.READY
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

    override suspend fun openSftp(): SftpChannel =
        MinaSftpChannel(
            SftpClientFactory.instance().createSftpClient(checkNotNull(session) { "SSH session is not connected" })
        )

    override suspend fun disconnect() {
        session?.close(false)
        client?.stop()
        session = null
        client = null
        mutableState.value = SessionState.CLOSED
    }
}
